import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { mergedHarness, sub, sourceCode, mp3, flac } from './helpers.mjs'

test('static subsources initialize and play when the host forbids dynamic code execution', async t => {
  let dynamicCalls = 0
  const blocked = () => { dynamicCalls++; throw new Error('Dynamic code execution is not allowed.') }
  const h = await mergedHarness(t, [sub('good', sourceCode("return 'https://example.test/good.mp3';"))], {
    allowCodeGeneration: false,
    globals: { Function: new Proxy(Function, { apply: blocked, construct: blocked }), eval: blocked },
  })
  assert.deepEqual(Object.keys(h.inited.sources), ['wy'])
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(dynamicCalls, 0)
})

test('a subsource requiring dynamic code is disabled without rejecting the whole initialization', async t => {
  const h = await mergedHarness(t, [sub('dynamic', `new Function('return globalThis')();`),
    sub('good', sourceCode("return 'https://example.test/good.mp3';"))])
  assert.equal(vm.runInContext('ENTRIES[0].status', h.context), 'error')
  assert.match(vm.runInContext('ENTRIES[0].error.message', h.context), /disallowed/)
  assert.equal(await h.call(), 'https://example.test/good.mp3')
})

test('static strict-mode sources retain independent globals, asynchronous closures, and the original raw script', async t => {
  const code = `
    'use strict';
    const privateValue = 'good';
    globalThis.marker = privateValue;
    if (this !== globalThis || window !== self || self !== global) throw new Error('wrong globals');
    lx.on('request', async()=>{
      await new Promise(resolve => setTimeout(resolve, 5));
      if (!lx.currentScriptInfo.rawScript.includes("const privateValue = 'good'")) throw new Error('missing raw script');
      return 'https://example.test/' + globalThis.marker + '.mp3';
    });
    lx.send('inited', { sources: { wy: { qualitys: ['320k'] } } });
  `
  const h = await mergedHarness(t, [sub('strict', code),
    sub('other', `globalThis.marker = 'wrong';` + sourceCode("return 'https://example.test/wrong.mp3';"))])
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(h.context.marker, undefined)
  assert.equal(vm.runInContext('ENTRIES[0].world.lx.currentScriptInfo.rawScript', h.context), code)
})

test('a hanging first source falls back and loses priority without being disabled', async t => {
  const h = await mergedHarness(t, [sub('hang', sourceCode('return await new Promise(()=>{});')),
    sub('good', sourceCode("return 'https://example.test/good.mp3';"))])
  assert.equal(await h.call(), 'https://example.test/good.mp3')
  assert.equal(vm.runInContext('ENTRIES[0].status', h.context), 'ready')
  assert.equal(vm.runInContext('ENTRIES[0].cooldowns.size', h.context), 1)
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
  const h = await mergedHarness(t, [sub('late', late), sub('good', good)], { allowCodeGeneration: true })
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
  const h = await mergedHarness(t, [sub('eval', code)], { allowCodeGeneration: true })
  assert.equal(await h.call(), 'https://example.test/good.mp3')
})

test('unhealthy platforms and undeclared qualities are not advertised or dispatched', async t => {
  const h = await mergedHarness(t, [sub('only320', sourceCode("return 'https://example.test/good.mp3';", ['320k']), { wy: ['320k'] })])
  assert.deepEqual(Object.keys(h.inited.sources), ['wy'])
  assert.deepEqual(Array.from(h.inited.sources.wy.qualitys), ['320k'])
  await assert.rejects(h.call('mg'), /not health-verified/)
  await assert.rejects(h.call('wy', 'flac'), /not health-verified/)
})

test('HEAD-only hosts advertise ordinary audio and explain how to enable lossless', async t => {
  let requests = 0
  const qualitys = ['320k', 'flac', 'flac24bit']
  const h = await mergedHarness(t, [sub('lossless', sourceCode("return 'https://example.test/good.flac';", qualitys), { wy: qualitys })], {
    request: (url, options, callback) => {
      requests++
      queueMicrotask(() => callback(null, { statusCode: 200, headers: { 'content-type': 'audio/flac' } }))
      return () => {}
    },
  })
  assert.deepEqual(Array.from(h.inited.sources.wy.qualitys), ['320k'])
  await assert.rejects(h.call('wy', 'flac24bit'), /requires a bounded byte probe/)
  await assert.rejects(h.call('wy', 'flac'), /requires a bounded byte probe/)
  assert.equal(requests, 0)
  assert.equal(await h.call('wy', '320k'), 'https://example.test/good.flac')
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

test('host prefix probes verify real FLAC even when the CDN labels it audio/mpeg', async t => {
  let probes = 0
  const qualitys = ['flac', 'flac24bit']
  const host = await mergedHarness(t, [sub('real', sourceCode("return 'https://example.test/real.flac';", qualitys), { wy: qualitys })], {
    request: () => { throw new Error('HEAD must not be used') },
    utils: { audioProbe: (url, options, callback) => {
      probes++
      assert.equal(options.maxBytes, 4096)
      queueMicrotask(() => callback(null, { statusCode: 206, contentType: 'audio/mpeg', bytes: Array.from(flac(24)) }))
      return () => {}
    } },
  })
  assert.deepEqual(Array.from(host.inited.sources.wy.qualitys), qualitys)
  assert.equal(await host.call('wy', 'flac24bit'), 'https://example.test/real.flac')
  assert.equal(probes, 1)
})

test('a hanging host probe is cancelled before falling back', async t => {
  let cancelled = false
  const h = await mergedHarness(t, ['stall', 'real'].map(name =>
    sub(name, sourceCode("return 'https://example.test/" + name + "';"))), {
    utils: { audioProbe: (url, options, callback) => {
      if (url.endsWith('stall')) return () => { cancelled = true }
      queueMicrotask(() => callback(null, { statusCode: 206, contentType: 'audio/mpeg', bytes: Array.from(mp3()) }))
      return () => {}
    } },
  })
  assert.equal(await h.call(), 'https://example.test/real')
  assert.equal(cancelled, true)
})

test('host prefix probes still reject fake lossless and JSON and fall back', async t => {
  const qualitys = ['flac']
  const h = await mergedHarness(t, ['mp3', 'json', 'real'].map(name =>
    sub(name, sourceCode("return 'https://example.test/" + name + "';", qualitys), { wy: qualitys })), {
    utils: { audioProbe: (url, options, callback) => {
      queueMicrotask(() => callback(null, { statusCode: 206,
        contentType: url.endsWith('json') ? 'application/json' : 'application/octet-stream',
        bytes: Array.from(url.endsWith('mp3') ? mp3() : flac()) }))
      return () => {}
    } },
  })
  assert.equal(await h.call('wy', 'flac'), 'https://example.test/real')
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
  const attempted = vm.runInContext('ENTRIES.filter(e=>e.cooldowns.size).length', h.context)
  assert.ok(attempted > 0 && attempted < 10)
  assert.equal(vm.runInContext('ENTRIES.every(e=>e.status === "ready")', h.context), true)
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

test('a timeout on one song does not prevent the same source from playing another', async t => {
  const h = await mergedHarness(t, [sub('recover', sourceCode(`
    if(input.info.musicInfo.songmid === 'slow') return await new Promise(()=>{});
    return 'https://example.test/good.mp3';
  `))])
  await assert.rejects(h.call('wy', '320k', { songmid: 'slow' }), /request timeout/)
  assert.equal(await h.call('wy', '320k', { songmid: 'fast' }), 'https://example.test/good.mp3')
  assert.equal(vm.runInContext('ENTRIES[0].cooldowns.size', h.context), 0)
})

test('URL acquisition and audio verification have separate deadlines', async t => {
  const h = await mergedHarness(t, [sub('slow', sourceCode(`
    await new Promise(resolve=>setTimeout(resolve,60)); return 'https://example.test/good.mp3';
  `))], {
    config: { embed: { requestTimeoutMs: 100, verifyTimeoutMs: 100, totalTimeoutMs: 300 } },
    request: (url, options, callback) => {
      const id = setTimeout(() => callback(null, { statusCode: 200, headers: { 'content-type': 'audio/mpeg' } }), 60)
      return () => clearTimeout(id)
    },
  })
  assert.equal(await h.call(), 'https://example.test/good.mp3')
})

test('one request timeout cannot cancel a concurrent successful song on the same source', async t => {
  const h = await mergedHarness(t, [sub('concurrent', sourceCode(`
    if(input.info.musicInfo.songmid === 'slow') return await new Promise(()=>{});
    await new Promise(resolve=>setTimeout(resolve,70)); return 'https://example.test/good.mp3';
  `))], { config: { embed: { requestTimeoutMs: 100, verifyTimeoutMs: 80, totalTimeoutMs: 300 } } })
  const slow = assert.rejects(h.call('wy', '320k', { songmid: 'slow' }), /request timeout/)
  await new Promise(resolve => setTimeout(resolve, 50))
  const fast = h.call('wy', '320k', { songmid: 'fast' })
  await slow
  assert.equal(await fast, 'https://example.test/good.mp3')
})

test('a late URL after timeout never starts a playback probe', async t => {
  const urls = []
  const h = await mergedHarness(t, [sub('late', sourceCode(`
    if(input.info.musicInfo.songmid === 'slow') await new Promise(resolve=>setTimeout(resolve,140));
    return 'https://example.test/' + input.info.musicInfo.songmid + '.mp3';
  `))], { request: (url, options, callback) => {
    urls.push(url)
    queueMicrotask(() => callback(null, { statusCode: 200, headers: { 'content-type': 'audio/mpeg' } }))
    return () => {}
  } })
  await assert.rejects(h.call('wy', '320k', { songmid: 'slow' }), /request timeout/)
  await h.call('wy', '320k', { songmid: 'fast' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(urls, ['https://example.test/fast.mp3'])
})

test('callback errors after initialization do not permanently disable a source', async t => {
  const h = await mergedHarness(t, [sub('callback', sourceCode(`
    if(input.info.musicInfo.songmid === 'bad') return await new Promise(resolve=>
      lx.request('https://example.test/api',{},()=>{throw new Error('bad response')}));
    return 'https://example.test/good.mp3';
  `))])
  await assert.rejects(h.call('wy', '320k', { songmid: 'bad' }), /request timeout/)
  assert.equal(await h.call(), 'https://example.test/good.mp3')
})

test('binary MIME and unsupported HEAD are inconclusive for ordinary audio, not dead links', async t => {
  for (const response of [
    { statusCode: 206, headers: { 'content-type': 'application/octet-stream' } },
    { statusCode: 200, headers: {} }, { statusCode: 405 }, { statusCode: 501 },
  ]) {
    const h = await mergedHarness(t, [sub('good', sourceCode("return 'https://example.test/good';"))], {
      request: (url, options, callback) => {
        assert.equal(options.method, 'HEAD')
        queueMicrotask(() => callback(null, response))
        return () => {}
      },
    })
    assert.equal(await h.call(), 'https://example.test/good')
  }
})

test('probe coverage ranks sources per platform/quality, and a cooldown eventually expires', async t => {
  const low = { ...sub('low', sourceCode("return 'https://example.test/low.mp3';")), reliability: { wy: { '320k': 0.5 } } }
  const high = { ...sub('high', sourceCode("return 'https://example.test/high.mp3';")), reliability: { wy: { '320k': 1 } } }
  const h = await mergedHarness(t, [low, high])
  assert.equal(await h.call(), 'https://example.test/high.mp3')
  vm.runInContext("ENTRIES[1].cooldowns.set('wy:320k', Date.now()+60)", h.context)
  assert.equal(await h.call(), 'https://example.test/low.mp3')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(await h.call(), 'https://example.test/high.mp3')
})
