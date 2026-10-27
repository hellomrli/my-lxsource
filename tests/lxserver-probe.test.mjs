import assert from 'node:assert/strict'
import test from 'node:test'
import createAudioProbe from '../integrations/lxserver/audio-probe.cjs'
import { server, flac } from './helpers.mjs'

const probe = (url, options = {}, agent) => new Promise((resolve, reject) =>
  createAudioProbe(agent)(url, options, (error, result) => error ? reject(error) : resolve(result)))

test('lxserver probes actual bytes without trusting inaccurate MIME or downloading the whole body', async t => {
  let closed
  const disconnected = new Promise(resolve => { closed = resolve })
  const base = await server(t, (req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.headers.range, 'bytes=0-4095')
    res.writeHead(200, { 'content-type': 'audio/mpeg' })
    res.write(Buffer.concat([flac(24), Buffer.alloc(60000)]))
    res.on('close', closed)
  })
  const result = await probe(base)
  assert.equal(result.bytes.length, 4096)
  assert.equal(Buffer.from(result.bytes).subarray(0, 4).toString(), 'fLaC')
  await disconnected
})

test('lxserver probes follow relative redirects and use the configured proxy category', async t => {
  const calls = []
  const base = await server(t, (req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/audio' }); res.end(); return }
    res.writeHead(206, { 'content-type': 'application/octet-stream' }); res.end(flac())
  })
  const result = await probe(base, {}, async (url, category) => { calls.push(category) })
  assert.equal(result.statusCode, 206)
  assert.equal(result.bytes.length, 4096)
  assert.deepEqual(calls, ['customSource', 'customSource'])
})

test('lxserver probes bound redirects, header stalls, body stalls, and proxy resolution', async t => {
  const base = await server(t, (req, res) => {
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); res.end() }
    if (req.url === '/body') { res.writeHead(200); res.flushHeaders() }
  })
  await assert.rejects(probe(base + '/loop'), /redirect limit/)
  await assert.rejects(probe(base, { timeout: 30 }), /timeout/)
  await assert.rejects(probe(base + '/body', { timeout: 30 }), /timeout/)
  await assert.rejects(probe(base, { timeout: 30 }, () => new Promise(() => {})), /timeout/)
})

test('lxserver probes reject non-HTTP and credential-bearing URLs', async () => {
  await assert.rejects(probe('file:///etc/passwd'), /Invalid playback URL/)
  await assert.rejects(probe('http://user:secret@example.test'), /Invalid playback URL/)
})

test('lxserver probe cancellation closes the request without delivering a late result', async t => {
  let called = false
  const base = await server(t, () => {})
  const cancel = createAudioProbe()(base, { timeout: 20 }, () => { called = true })
  cancel()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(called, false)
})
