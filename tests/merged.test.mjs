import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { mergedHarness, sub, sourceCode, mp3, flac } from './helpers.mjs'

test('a hanging first source falls back and is disabled without affecting other sources', async t => {
  const h = await mergedHarness(t, [sub('hang', sourceCode('return await new Promise(()=>{});')),
    sub('good', sourceCode("return 'https://example.test/good.mp3';"))])
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(vm.runInContext('ENTRIES[0].status', h.context), 'error')
  assert.equal(await h.call(), 'https://example.test/good.mp3')
})

test('404 playback URLs fall back to the next source; HEAD does not download the song', async t => {
  const methods = []
  const h = await mergedHarness(t, [sub('dead', sourceCode("return 'https://example.test/dead.mp3';")),
    sub('good', sourceCode("return 'https://example.test/good.mp3';"))], {
    request: (url, options, callback) => {
      methods.push(options.method)
      queueMicrotask(() => callback(null, { statusCode: url.includes('dead') ? 404 : 206,
        headers: { 'content-type': 'audio/mpeg' } }))
      return () => {}
    },
  })
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.deepEqual(methods, ['HEAD', 'HEAD'])
})

test('HEAD HTML and hanging probes do not short-circuit fallback', async t => {
  const h = await mergedHarness(t, [sub('html', sourceCode("return 'https://example.test/html';")),
    sub('stall', sourceCode("return 'https://example.test/stall';")),
    sub('good', sourceCode("return 'https://example.test/good.mp3';"))], {
    request: (url, options, callback) => {
      if (!url.includes('stall')) queueMicrotask(() => callback(null, { statusCode: 200,
        headers: { 'content-type': url.includes('html') ? 'text/html' : 'audio/mpeg' } }))
      return () => {}
    },
  })
  assert.equal(await h.call(), 'https://example.test/good.mp3')
})

test('late init, dynamic Function, eval, aliases, and asynchronous global lx reads stay in their own scope', async t => {
  const late = `setTimeout(()=>{globalThis.lx.on('request',async()=> 'https://example.test/wrong.mp3');
    globalThis.lx.send('inited',{sources:{wy:{qualitys:['320k']}}});}, 100);`
  const good = `
    new Function("globalThis.lx.on('request', async()=>{await new Promise(r=>setTimeout(r,5));return 'https://example.test/good.mp3'})")();
    eval("globalThis.marker = 'only-good'");
    window.lx.send('inited',{sources:{wy:{qualitys:['320k']}}});
  `
  const h = await mergedHarness(t, [sub('late', late), sub('good', good)])
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(h.context.lx, h.lx)
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(vm.runInContext('ENTRIES[0].handlers.length', h.context), 0)
  assert.equal(vm.runInContext('ENTRIES[1].handlers.length', h.context), 1)
  assert.equal(h.context.marker, undefined)
})

test('direct eval retains subsource lexical variables while its global objects remain scoped', async t => {
  const code = `
    const privateValue = 'good';
    globalThis.lx.on('request', async()=>{
      const host = eval('globalThis.lx');
      if (host !== globalThis.lx) throw new Error('wrong scope');
      return 'https://example.test/' + eval('privateValue') + '.mp3';
    });
    globalThis.lx.send('inited',{sources:{wy:{qualitys:['320k']}}});
  `
  const h = await mergedHarness(t, [sub('eval', code)])
  assert.equal(await h.call(), 'https://example.test/good.mp3')
})

test('unhealthy platforms and undeclared qualities are not advertised or dispatched', async t => {
  const h = await mergedHarness(t, [sub('only320', sourceCode("return 'https://example.test/good.mp3';", ['320k']), { wy: ['320k'] })])
  assert.deepEqual(Object.keys(h.inited.sources), ['wy'])
  assert.deepEqual(Array.from(h.inited.sources.wy.qualitys), ['320k'])
  await assert.rejects(h.call('mg'), /not health-verified/)
  await assert.rejects(h.call('wy', 'flac'), /not health-verified/)
})

test('HEAD-only hosts do not advertise or accept unverifiable 24-bit quality', async t => {
  let requests = 0
  const qualitys = ['320k', 'flac', 'flac24bit']
  const h = await mergedHarness(t, [sub('lossless', sourceCode("return 'https://example.test/good.flac';", qualitys), { wy: qualitys })], {
    request: (url, options, callback) => {
      requests++
      queueMicrotask(() => callback(null, { statusCode: 200, headers: { 'content-type': 'audio/flac' } }))
      return () => {}
    },
  })
  assert.deepEqual(Array.from(h.inited.sources.wy.qualitys), ['320k', 'flac'])
  await assert.rejects(h.call('wy', 'flac24bit'), /not health-verified/)
  assert.equal(requests, 0)
  assert.equal(await h.call('wy', 'flac'), 'https://example.test/good.flac')
})

test('buffered fetch implementations use HEAD without downloading a song', async t => {
  let fetches = 0
  const h = await mergedHarness(t, [sub('good', sourceCode("return 'https://example.test/good.mp3';"))], {
    fetch: async () => { fetches++; throw new Error('Buffered fetch must not be used') },
    globals: { ReadableStream: undefined },
  })
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(fetches, 0)
})

test('streaming hosts verify 24-bit samples and fall back from 16-bit audio', async t => {
  const qualitys = ['flac24bit']
  const h = await mergedHarness(t, [
    sub('16bit', sourceCode("return 'https://example.test/16bit.flac';", qualitys), { wy: qualitys }),
    sub('24bit', sourceCode("return 'https://example.test/24bit.flac';", qualitys), { wy: qualitys }),
  ], {
    fetch: async url => ({ status: 206, headers: new Headers({ 'content-type': 'audio/flac' }),
      body: new ReadableStream({ start(controller) { controller.enqueue(flac(url.includes('16bit') ? 16 : 24)) } }) }),
  })
  assert.deepEqual(Array.from(h.inited.sources.wy.qualitys), ['flac24bit'])
  assert.equal(await h.call('wy', 'flac24bit'), 'https://example.test/24bit.flac')
})

test('playback total deadline bounds a long fallback chain', async t => {
  const h = await mergedHarness(t, Array.from({ length: 10 }, (_, i) => sub(`hang${i}`, sourceCode('return await new Promise(()=>{});'))), {
    config: { embed: { initTimeoutMs: 60, requestTimeoutMs: 50, totalTimeoutMs: 110, verifyTimeoutMs: 30 } },
  })
  const start = Date.now()
  await assert.rejects(h.call(), /All embedded sources failed/)
  assert.ok(Date.now() - start < 500)
  assert.ok(vm.runInContext('ENTRIES.filter(e=>e.status === "error").length', h.context) < 10)
})

test('streaming playback verification is bounded even when Range is ignored', async t => {
  let cancelCount = 0
  const h = await mergedHarness(t, [sub('good', sourceCode("return 'https://example.test/good.mp3';"))], {
    fetch: async () => ({ status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }),
      body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.concat([mp3(), Buffer.alloc(60000)])) },
        cancel() { cancelCount++ } }) }),
  })
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(cancelCount, 1)
})

test('a streaming playback body stall is aborted and the next source is tried', async t => {
  let cancelled = false
  const h = await mergedHarness(t, [sub('stall', sourceCode("return 'https://example.test/stall.mp3';")),
    sub('good', sourceCode("return 'https://example.test/good.mp3';"))], {
    fetch: async (url, options) => ({ status: 200, headers: new Headers({ 'content-type': 'audio/mpeg' }),
      body: new ReadableStream({ start(controller) {
        if (url.includes('stall')) options.signal.addEventListener('abort', () => {
          cancelled = true; controller.error(new Error('aborted'))
        }, { once: true })
        else controller.enqueue(mp3())
      } }) }),
  })
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(cancelled, true)
})

test('a source mutating request metadata cannot change fallback input', async t => {
  const h = await mergedHarness(t, [sub('mutate', sourceCode("input.info.musicInfo.songmid='wrong'; throw new Error('failed');")),
    sub('good', sourceCode("return 'https://example.test/' + input.info.musicInfo.songmid + '.mp3';"))])
  assert.equal(await h.call('wy', '320k', { songmid: 'original' }), 'https://example.test/original.mp3')
})
