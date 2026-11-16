import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AvailabilityError, upstreamUnavailable } from '../scripts/availability.mjs'
import { runFetch } from '../scripts/fetch-upstream.mjs'
import { tempDir, sourceCode } from './helpers.mjs'

test('known upstream HTTP and network outages are distinguished from program, policy and disk errors', () => {
  for (const message of ['Download HTTP 403', 'HTTP 404', 'Download HTTP 408', 'Download HTTP 410',
    'HTTP 425', 'HTTP 429', 'Download HTTP 502', 'HTTP deadline exceeded', 'HTTP body interrupted']) {
    assert.equal(upstreamUnavailable(new Error(message)), true, message)
  }
  for (const code of ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'CERT_HAS_EXPIRED']) {
    assert.equal(upstreamUnavailable(Object.assign(new Error(''), { code })), true, code)
  }
  assert.equal(upstreamUnavailable(new DOMException('cancelled', 'AbortError')), true)
  for (const error of [new SyntaxError('Unexpected token'), new TypeError('bad config'),
    new Error('Invalid commit'), new Error('Incomplete Git tree'), new Error('Private or reserved network addresses are blocked'),
    new Error('HTTP response exceeds 64 bytes'), new Error('Download HTTP 401'), new Error('Download HTTP 400'),
    Object.assign(new Error('disk error'), { code: 'EACCES' }), Object.assign(new Error('missing file'), { code: 'ENOENT' })]) {
    assert.equal(upstreamUnavailable(error), false, error.message)
  }
  const network = Object.assign(new Error(''), { code: 'ETIMEDOUT' })
  assert.equal(upstreamUnavailable(new AggregateError([network, new Error('HTTP 503')])), true)
  assert.equal(upstreamUnavailable(new AggregateError([network, new SyntaxError('invalid response')])), false)
  assert.equal(upstreamUnavailable(new AggregateError([])), false)
})

test('fetch outages are typed, while mixed discovery errors and malformed responses stay fatal', async t => {
  const dir = await tempDir(t), statePath = path.join(dir, 'state.json')
  const previous = '{"sources":{"keep":{"sha256":"old"}}}\n'
  await fs.writeFile(statePath, previous)
  const options = { statePath, upstreams: { fixture: { repo: 'owner/repo', branch: 'main' } } }
  await assert.rejects(runFetch({ ...options, download: async () => { throw new Error('Download HTTP 503') } }), error => {
    assert.ok(error instanceof AvailabilityError)
    assert.equal(error.stage, 'fetch')
    return true
  })
  await assert.rejects(runFetch({ ...options, download: async () => '<html>bad API response</html>' }), error => {
    assert.ok(!(error instanceof AvailabilityError))
    return true
  })
  await assert.rejects(runFetch({ ...options, upstreams: { ...options.upstreams, bad: { repo: 'bad/repo', branch: 'main' } },
    download: async url => {
      if (url.includes('/bad/repo/')) return 'not JSON'
      throw new Error('Download HTTP 503')
    } }), error => {
    assert.ok(!(error instanceof AvailabilityError))
    assert.match(error.message, /fixture:/)
    assert.match(error.message, /bad:/)
    return true
  })
  assert.equal(await fs.readFile(statePath, 'utf8'), previous)
})

test('snapshot persistence errors cannot be classified as upstream outages', async t => {
  const dir = await tempDir(t), cacheDir = path.join(dir, 'not-a-directory')
  await fs.writeFile(cacheDir, 'disk fixture')
  await assert.rejects(runFetch({ statePath: path.join(dir, 'state.json'), cacheDir,
    upstreams: { fixture: { repo: 'owner/repo', branch: 'main' } }, download: async url => {
      if (url.includes('/commits/')) return JSON.stringify({ sha: 'a'.repeat(40) })
      if (url.includes('/git/trees/')) return JSON.stringify({ tree: [{ type: 'blob', path: 'latest.js' }] })
      return sourceCode("return 'https://example.test/audio.mp3';")
    } }), error => {
    assert.ok(!(error instanceof AvailabilityError))
    return true
  })
})
