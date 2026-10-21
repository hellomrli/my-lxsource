import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSource } from '../scripts/lx-runtime.mjs'
import { server, sourceCode } from './helpers.mjs'

test('the sandbox can emulate clients that prohibit eval and Function', async t => {
  const good = await loadSource(sourceCode("return 'https://example.test/audio.mp3';"), {
    timeoutMs: 1000, allowCodeGeneration: false,
  })
  t.after(() => good.dispose())
  assert.equal(good.error, null)
  assert.equal(await good.callMusicUrl('wy', {}, '320k'), 'https://example.test/audio.mp3')
  for (const code of ["new Function('return globalThis')()", "eval('globalThis')"]) {
    const blocked = await loadSource(code, { timeoutMs: 1000, allowCodeGeneration: false })
    t.after(() => blocked.dispose())
    assert.match(blocked.error, /Code generation from strings disallowed/)
  }
})

test('source execution cannot read host secrets or spawn child processes even after a VM escape', async t => {
  process.env.LX_TEST_SECRET = 'must-not-leak'
  t.after(() => { delete process.env.LX_TEST_SECRET })
  const rt = await loadSource(sourceCode(`
    const p=lx.on.constructor('return process')();
    const result={secret:!!p.env.LX_TEST_SECRET};
    try{p.getBuiltinModule('node:fs').readFileSync('/home/lain/.gitconfig');result.fs=true}catch(e){result.fs=e.code}
    try{p.getBuiltinModule('node:child_process').spawn('/runner/node');result.spawn=true}catch(e){result.spawn=e.code}
    return JSON.stringify(result);
  `), { timeoutMs: 1000 })
  t.after(() => rt.dispose())
  assert.equal(rt.error, null)
  const result = JSON.parse(await rt.callMusicUrl('wy', {}, '320k'))
  assert.equal(result.secret, false)
  assert.equal(result.fs, 'ERR_ACCESS_DENIED')
  assert.equal(result.spawn, 'ERR_ACCESS_DENIED')
})

test('script HTTP uses the broker, parses JSON, and supplies all LX callback arguments', async t => {
  const url = await server(t, (_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('{"url":"https://example.test/audio.mp3"}')
  })
  const rt = await loadSource(sourceCode(`return await new Promise((resolve,reject)=>lx.request(${JSON.stringify(url)}, {},
    (err,resp,body)=>err?reject(err):resolve(body.url===resp.body.url && resp.raw.length>0 ? body.url : 'bad')));`),
  { timeoutMs: 1000, allowPrivateNetwork: true })
  t.after(() => rt.dispose())
  assert.equal(rt.error, null)
  assert.equal(await rt.callMusicUrl('wy', {}, '320k'), 'https://example.test/audio.mp3')
})

test('private HTTP requests are blocked by default', async t => {
  const rt = await loadSource(sourceCode(`return await new Promise(resolve=>lx.request('http://169.254.169.254/latest/meta-data',{},
    err=>resolve(err ? err.message : 'UNEXPECTED_SUCCESS')));`), { timeoutMs: 1000 })
  t.after(() => rt.dispose())
  assert.equal(rt.error, null)
  assert.match(await rt.callMusicUrl('wy', {}, '320k'), /Private or reserved/)
})

test('broker timeout includes the API response body', async t => {
  const url = await server(t, (_, res) => { res.writeHead(200); res.write('partial') })
  const rt = await loadSource(sourceCode(`return await new Promise(resolve=>lx.request(${JSON.stringify(url)},{timeout:60},
    err=>resolve(err ? err.message : 'UNEXPECTED_SUCCESS')));`), { timeoutMs: 1000, allowPrivateNetwork: true })
  t.after(() => rt.dispose())
  assert.match(await rt.callMusicUrl('wy', {}, '320k'), /deadline/i)
})

test('init loops, sync request loops, and async hangs are bounded; disposal kills all timers', async t => {
  const invalid = await loadSource('while(true) {}', { timeoutMs: 80 })
  assert.match(invalid.error, /timeout|failed/i)
  invalid.dispose()
  for (const body of ['while(true) {}', 'return await new Promise(()=>{});', 'setInterval(()=>{},10); return await new Promise(()=>{});']) {
    const rt = await loadSource(sourceCode(body), { timeoutMs: 120 })
    t.after(() => rt.dispose())
    assert.equal(rt.error, null)
    await assert.rejects(rt.callMusicUrl('wy', {}, '320k'), /timeout|timed out/i)
    rt.dispose()
    assert.equal(rt.closed, true)
  }
})

test('unhandled subsource failures do not install global handlers in the trusted process', async t => {
  const rejection = process.listenerCount('unhandledRejection')
  const exceptions = process.listenerCount('uncaughtException')
  const rt = await loadSource(`Promise.reject(new Error('broken async init'));`, { timeoutMs: 500 })
  t.after(() => rt.dispose())
  assert.match(rt.error, /broken async init|failed|exited/i)
  assert.equal(process.listenerCount('unhandledRejection'), rejection)
  assert.equal(process.listenerCount('uncaughtException'), exceptions)
})

test('malformed IPC from a compromised worker cannot crash the trusted process', async t => {
  const rt = await loadSource(`lx.on.constructor('return process')().stdout.write('null\\n');`, { timeoutMs: 1000 })
  t.after(() => rt.dispose())
  assert.match(rt.error, /Invalid sandbox IPC/)
})

test('synchronous errors after inited still reject initialization', async t => {
  const rt = await loadSource(sourceCode("return 'https://example.test/audio.mp3';") +
    "throw new Error('failed after inited')", { timeoutMs: 1000 })
  t.after(() => rt.dispose())
  assert.match(rt.error, /failed after inited/)
})
