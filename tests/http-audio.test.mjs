import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { isPublicAddress, parseHttpUrl, requestBytes } from '../scripts/http.mjs'
import { verifyAudioUrl, sniffAudio } from '../scripts/lx-runtime.mjs'
import { qualityMatchesAudio } from '../scripts/audio.mjs'
import { server, mp3, flac } from './helpers.mjs'

test('private, mapped, reserved, and metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.1.2', '192.168.0.1', '169.254.169.254',
    '100.64.1.2', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) assert.equal(isPublicAddress(ip), false, ip)
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(ip), true, ip)
  }
  assert.throws(() => parseHttpUrl('file:///etc/passwd'))
  assert.throws(() => parseHttpUrl('https://user:pass@example.test/audio'))
})

test('body stalls cannot bypass the HTTP deadline after headers', async t => {
  const url = await server(t, (_, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
    res.write(mp3().subarray(0, 10))
  })
  const result = await verifyAudioUrl(url, { allowPrivateNetwork: true, timeoutMs: 60 })
  assert.equal(result.ok, false)
  assert.match(result.error, /deadline/i)
})

test('ignored Range is read only up to the prefix limit and the stream is cancelled', async t => {
  let closed = false
  const url = await server(t, (_, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': '100000000' })
    res.write(mp3())
    res.once('close', () => { closed = true })
  })
  const result = await verifyAudioUrl(url, { allowPrivateNetwork: true, timeoutMs: 500 })
  assert.equal(result.ok, true)
  assert.equal(result.bytes, 4096)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(closed, true)
})

test('normal API bodies are size limited', async t => {
  const url = await server(t, (_, res) => res.end(Buffer.alloc(4096)))
  await assert.rejects(requestBytes(url, { allowPrivateNetwork: true, maxBytes: 64 }), /exceeds/)
})

test('404 and 410 are not L2 successes, and redirects are checked for SSRF', async t => {
  const url = await server(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return }
    res.writeHead(req.url === '/gone' ? 410 : 404, { 'Content-Type': 'audio/mpeg' })
    res.end(mp3())
  })
  for (const p of ['/gone', '/missing']) {
    const result = await verifyAudioUrl(url + p, { allowPrivateNetwork: true })
    assert.equal(result.connected, false)
    assert.equal(result.ok, false)
  }
  await assert.rejects(requestBytes(url), /Private or reserved/)
})

test('every redirect destination is rechecked and denied before a private connection is opened', async t => {
  const original = http.request
  t.after(() => { http.request = original })
  let requests = 0
  http.request = (url, options, callback) => {
    requests++
    assert.equal(url.hostname, '1.1.1.1')
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => callback({ statusCode: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' }, destroy() {} }))
    return req
  }
  await assert.rejects(requestBytes('http://1.1.1.1/redirect'), /Private or reserved/)
  assert.equal(requests, 1)
})

test('WAV and AAC detection is correct; video containers are not misclassified as audio', () => {
  assert.equal(sniffAudio(Buffer.from('RIFF1234WAVE')), 'wav')
  assert.equal(sniffAudio(Buffer.from('RIFF1234AVI ')), null)
  assert.equal(sniffAudio(Buffer.from([255, 241, 80, 128, 0, 255, 252])), 'aac')
  assert.equal(sniffAudio(Buffer.from([255, 251, 144, 0])), 'mp3(frame)')
  const mp4 = Buffer.alloc(24)
  mp4.writeUInt32BE(24)
  mp4.write('ftypisom', 4)
  assert.equal(sniffAudio(mp4), null)
  mp4.write('M4A ', 16)
  assert.equal(sniffAudio(mp4), 'm4a')
  const ogg = Buffer.alloc(64)
  ogg.write('OggS'); ogg[26] = 1; ogg[27] = 8; ogg.write('OpusHead', 28)
  assert.equal(sniffAudio(ogg), 'ogg')
  ogg.write('theora!!', 28)
  assert.equal(sniffAudio(ogg), null)
})

test('lossless requests cannot be satisfied with MP3 or a wrong bit depth', async t => {
  assert.equal(qualityMatchesAudio('flac', 'mp3(ID3)', mp3()), false)
  assert.equal(qualityMatchesAudio('flac24bit', 'flac', flac(16)), false)
  assert.equal(qualityMatchesAudio('flac24bit', 'flac', flac(24)), true)
  const url = await server(t, (req, res) => {
    res.writeHead(206, { 'Content-Type': req.url === '/html' ? 'text/html' : 'audio/mpeg' })
    res.end(mp3())
  })
  assert.equal((await verifyAudioUrl(url, { allowPrivateNetwork: true, quality: 'flac' })).ok, false)
  assert.equal((await verifyAudioUrl(url + '/html', { allowPrivateNetwork: true })).ok, false)
})
