import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  let input = address.toLowerCase()
  if (input.includes('.')) {
    const split = input.lastIndexOf(':')
    const octets = input.slice(split + 1).split('.').map(Number)
    input = input.slice(0, split + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' +
      ((octets[2] << 8) | octets[3]).toString(16)
  }
  const [left, right] = input.split('::')
  const start = left ? left.split(':') : []
  const end = right ? right.split(':') : []
  const parts = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end]
  const words = parts.map(p => Number.parseInt(p, 16))
  if (words.slice(0, 5).every(n => n === 0) && words[5] === 0xffff) {
    return isPublicAddress(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`)
  }
  return (words[0] & 0xe000) === 0x2000 && words[0] !== 0x2002 && words[0] !== 0x3fff &&
    !(words[0] === 0x2001 && [0, 2, 0x10, 0x20, 0xdb8].includes(words[1]))
}

export function parseHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid HTTP URL')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free HTTP(S) URLs are allowed')
  }
  return url
}

export function boundedNumber(value, fallback, min = 1, max = 60000) {
  const n = Number(value)
  return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), max) : fallback
}

function publicLookup(hostname, options, callback) {
  lookup(hostname, { all: true }).then(addresses => {
    // Pin the connection to these checked addresses; a separate fetch would permit DNS rebinding.
    if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
      throw new Error('Private or reserved network addresses are blocked')
    }
    const family = typeof options === 'number' ? options : options?.family
    const candidates = family ? addresses.filter(a => a.family === family) : addresses
    if (!candidates.length) throw new Error('No usable public address')
    if (options?.all) callback(null, candidates)
    else callback(null, candidates[0].address, candidates[0].family)
  }).catch(error => callback(error))
}

/** A single deadline covers DNS, redirects, headers, and body consumption. */
export async function requestBytes(value, {
  method = 'GET', headers = {}, body, timeoutMs = 20000, maxBytes = 1048576,
  prefix = false, signal, allowPrivateNetwork = false, maxRedirects = 5,
} = {}) {
  let url = parseHttpUrl(value)
  method = String(method).toUpperCase()
  headers = { ...headers }
  maxBytes = boundedNumber(maxBytes, 1048576, 1, 8388608)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('HTTP deadline exceeded')),
    boundedNumber(timeoutMs, 20000))
  const abort = () => controller.abort(signal.reason || new Error('HTTP request cancelled'))
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    for (let redirects = 0; ; redirects++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      if (!allowPrivateNetwork && isIP(hostname) && !isPublicAddress(hostname)) {
        throw new Error('Private or reserved network addresses are blocked')
      }
      const response = await new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http
        const req = transport.request(url, {
          method, headers, signal: controller.signal,
          lookup: allowPrivateNetwork ? undefined : publicLookup,
          agent: false,
        }, res => {
          const base = { statusCode: res.statusCode, headers: res.headers, url: url.href }
          const location = res.headers.location
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && location) {
            res.destroy()
            resolve({ ...base, location, raw: Buffer.alloc(0) })
            return
          }
          if (!prefix && Number(res.headers['content-length']) > maxBytes && method !== 'HEAD') {
            res.destroy()
            reject(new Error(`HTTP response exceeds ${maxBytes} bytes`))
            return
          }
          const chunks = []
          let size = 0, settled = false
          const finish = error => {
            if (settled) return
            settled = true
            if (error) reject(error)
            else resolve({ ...base, raw: Buffer.concat(chunks, size), bytes: size })
          }
          res.on('data', chunk => {
            if (settled) return
            if (!prefix && size + chunk.length > maxBytes) {
              finish(new Error(`HTTP response exceeds ${maxBytes} bytes`))
              res.destroy()
              return
            }
            const part = chunk.subarray(0, Math.min(chunk.length, maxBytes - size))
            chunks.push(part)
            size += part.length
            if (prefix && size === maxBytes) {
              finish()
              res.destroy()
            }
          })
          res.once('end', () => finish())
          res.once('error', finish)
          res.once('aborted', () => finish(new Error('HTTP body interrupted')))
        })
        req.once('error', reject)
        req.end(body)
      })
      if (!response.location) return response
      if (redirects >= maxRedirects) throw new Error('Too many HTTP redirects')
      const target = parseHttpUrl(new URL(response.location, url).href)
      if (target.origin !== url.origin) {
        for (const key of Object.keys(headers)) {
          if (/^(authorization|cookie|host)$/i.test(key)) delete headers[key]
        }
      }
      if (response.statusCode === 303 || ([301, 302].includes(response.statusCode) && method === 'POST')) {
        method = 'GET'
        body = undefined
        for (const key of Object.keys(headers)) if (/^content-(length|type)$/i.test(key)) delete headers[key]
      }
      url = target
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export async function requestText(url, options) {
  const response = await requestBytes(url, options)
  if (response.statusCode !== 200) throw new Error(`Download HTTP ${response.statusCode}`)
  return response.raw.toString('utf8')
}
