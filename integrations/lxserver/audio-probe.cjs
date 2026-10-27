'use strict'
const http = require('node:http')
const https = require('node:https')

// Keep this API narrower than fetch: GET only, a 4 KiB prefix, and an 8 s total deadline.
module.exports = function createAudioProbe(getProxyAgent) {
  return function audioProbe(input, options, callback) {
    const limit = (value, fallback, max) => Number.isFinite(Number(value))
      ? Math.max(1, Math.min(max, Math.floor(Number(value)))) : fallback
    const timeout = limit(options && options.timeout, 8000, 8000)
    const maxBytes = limit(options && options.maxBytes, 4096, 4096)
    let request, response, settled = false, size = 0
    const chunks = []
    const stop = () => {
      if (response) response.destroy()
      if (request) request.destroy()
    }
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = response && { statusCode: response.statusCode,
        contentType: String(response.headers['content-type'] || ''),
        bytes: Array.from(Buffer.concat(chunks, size)) }
      stop()
      callback(error || null, error ? null : result)
    }
    const timer = setTimeout(() => finish(new Error('Playback probe timeout')), timeout)
    const visit = async (value, depth = 0) => {
      if (settled) return
      const url = new URL(value)
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 16384) {
        throw new Error('Invalid playback URL')
      }
      const agent = getProxyAgent ? await getProxyAgent(url.href, 'customSource') : undefined
      if (settled) return
      request = (url.protocol === 'https:' ? https : http).request(url, { method: 'GET', agent,
        headers: { Range: `bytes=0-${maxBytes - 1}`, 'Accept-Encoding': 'identity', 'User-Agent': 'Mozilla/5.0' } }, res => {
        if (settled) { res.destroy(); return }
        response = res
        res.on('error', error => finish(error))
        res.on('aborted', () => { if (!settled) finish(new Error('Playback probe response aborted')) })
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (depth >= 5) { finish(new Error('Playback probe redirect limit')); return }
          let next
          try { next = new URL(res.headers.location, url).href }
          catch (_) { finish(new Error('Invalid playback redirect')); return }
          response = undefined
          res.removeAllListeners('aborted')
          res.destroy()
          visit(next, depth + 1).catch(finish)
          return
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) { finish(); return }
        res.on('data', chunk => {
          if (settled) return
          const part = chunk.subarray(0, maxBytes - size)
          chunks.push(part); size += part.length
          if (size >= maxBytes) finish()
        })
        res.on('end', () => finish())
      })
      request.on('error', error => { if (!settled) finish(error) })
      request.end()
    }
    visit(input).catch(finish)
    return () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
    }
  }
}
