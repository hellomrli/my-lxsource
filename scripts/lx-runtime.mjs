/**
 * 无头 LX Music 运行时
 * 在 Node 里模拟 globalThis.lx，让音源脚本可以脱离客户端被调用。
 * 依据官方规范: https://lxmusic.toside.cn/desktop/custom-source
 */
import vm from 'node:vm'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { Buffer } from 'node:buffer'

// 音源脚本内部常用 Promise.any 且不处理全部失败的情况，
// 会产生未处理的 rejection。静默掉，避免把巡检进程带崩。
process.on('unhandledRejection', () => {})
process.on('uncaughtException', (err) => {
  // 仅记录，不让单个脚本的异常终止整个巡检
  if (process.env.LX_GUARD_DEBUG) console.error('[runtime]', err?.message)
})

const EVENT_NAMES = {
  inited: 'inited',
  request: 'request',
  updateAlert: 'updateAlert',
}

/** 从脚本文本解析头部元数据注释 */
export function parseMeta(script) {
  const m = script.match(/\/\*!?([\s\S]*?)\*\//)
  if (!m) return {}
  const meta = {}
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*\*?\s*@(\w+)\s+(.*)$/)
    if (mm) meta[mm[1]] = mm[2].trim()
  }
  return meta
}

/** 极简 HTTP 请求，兼容 lx.request 的 callback(err, resp) 签名 */
function httpRequest(url, options = {}, callback) {
  const ac = new AbortController()
  const method = options.method || 'GET'
  const headers = options.headers || {}
  let body = options.body
  if (options.form && typeof options.form === 'object') {
    body = new URLSearchParams(options.form).toString()
    headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded'
  }
  const timeout = setTimeout(() => ac.abort(), options.timeout || 20000)
  fetch(url, { method, headers, body, signal: ac.signal, redirect: 'follow' })
    .then(async (res) => {
      clearTimeout(timeout)
      const text = await res.text()
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      // 与 LX 宿主保持一致：JSON 响应自动解析为对象，其余保留字符串
      let body = text
      if (ct.includes('json')) {
        try { body = JSON.parse(text) } catch { body = text }
      }
      const headers = {}
      for (const [k, v] of res.headers.entries()) headers[k] = v
      const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : null
      if (sc && sc.length) headers['set-cookie'] = sc
      callback(null, { statusCode: res.status, headers, body, rawBody: text })
    })
    .catch((err) => {
      clearTimeout(timeout)
      callback(err)
    })
  return () => ac.abort()
}

/**
 * 在隔离上下文中加载音源脚本
 * @returns {Promise<{meta, sources, callMusicUrl, errors}>}
 */
export async function loadSource(script, { timeoutMs = 30000 } = {}) {
  const meta = parseMeta(script)
  const state = { sources: null, initedError: null, initResolve: null, initReject: null, requestHandlers: [] }
  const initedPromise = new Promise((res, rej) => {
    state.initResolve = res
    state.initReject = rej
  })

  const lx = {
    version: 2,
    env: 'desktop',
    currentScriptInfo: { ...meta, rawScript: script },
    EVENT_NAMES,
    on(event, handler) {
      if (event === EVENT_NAMES.request) state.requestHandlers.push(handler)
    },
    send(event, data) {
      if (event === EVENT_NAMES.inited) {
        state.sources = data?.sources || {}
        state.initResolve({ sources: state.sources })
      }
    },
    request: httpRequest,
    utils: {
      buffer: { from: (v, enc) => Buffer.from(v, enc), bufToString: (b, f) => Buffer.from(b).toString(f) },
      crypto: {
        md5: (s) => crypto.createHash('md5').update(s).digest('hex'),
        randomBytes: (n) => crypto.randomBytes(n).toString('hex'),
        aesEncrypt: (buf, mode, key, iv) => {
          const c = crypto.createCipheriv(mode, Buffer.from(key), iv ? Buffer.from(iv) : null)
          return Buffer.concat([c.update(Buffer.from(buf)), c.final()])
        },
        rsaEncrypt: (buf, key) => crypto.publicEncrypt(key, Buffer.from(buf)),
      },
      zlib: {
        inflate: (b) => new Promise((res, rej) => zlib.inflate(Buffer.from(b), (e, r) => e ? rej(e) : res(r))),
        deflate: (b) => new Promise((res, rej) => zlib.deflate(Buffer.from(b), (e, r) => e ? rej(e) : res(r))),
      },
    },
  }

  const sandbox = {
    lx,
    globalThis: null,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    Promise, Error, JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Map, Set, Symbol,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.self = sandbox

  try {
    const ctx = vm.createContext(sandbox)
    new vm.Script(script, { filename: meta.name || 'source.js' }).runInContext(ctx, { timeout: timeoutMs })
  } catch (err) {
    return { meta, sources: {}, error: `脚本执行失败: ${err.message}`, callMusicUrl: null }
  }

  // 等待 inited（带超时）
  let inited
  try {
    inited = await Promise.race([
      initedPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('等待 inited 超时')), timeoutMs)),
    ])
  } catch (err) {
    return { meta, sources: {}, error: err.message, callMusicUrl: null }
  }

  const callMusicUrl = async (source, musicInfo, quality) => {
    const handler = state.requestHandlers[0]
    if (!handler) throw new Error('脚本未注册 request 事件')
    const p = handler({ source, action: 'musicUrl', info: { type: quality, musicInfo } })
    if (!p || typeof p.then !== 'function') throw new Error('handler 未返回 Promise')
    return await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('musicUrl 超时')), timeoutMs)),
    ])
  }

  return { meta, sources: inited.sources, state, callMusicUrl, error: null }
}

/** 判断一个 URL 是否返回真正的音频 */
export async function verifyAudioUrl(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-2047' },
      signal: ac.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    const buf = Buffer.from(await res.arrayBuffer())
    const magic = sniffAudio(buf)
    const ctOk = /audio|mpeg|mp3|flac|m4a|aac|ogg/.test(ct)
    return {
      ok: res.status >= 200 && res.status < 300 && (magic !== null),
      status: res.status,
      contentType: ct,
      magic,
      ctOk,
      bytes: buf.length,
    }
  } catch (err) {
    clearTimeout(timer)
    return { ok: false, status: 0, error: err.message, magic: null, ctOk: false, bytes: 0 }
  }
}

/** 音频文件魔数识别 */
export function sniffAudio(buf) {
  if (!buf || buf.length < 4) return null
  const b = buf
  if (b.slice(0, 3).toString('ascii') === 'ID3') return 'mp3(ID3)'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3(frame)'
  if (b.slice(0, 4).toString('ascii') === 'fLaC') return 'flac'
  if (b.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4/m4a'
  if (b.slice(0, 4).toString('ascii') === 'OggS') return 'ogg'
  if (b.slice(0, 2).toString('ascii') === 'RIFF') return 'wav'
  // ADTS AAC
  if (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) return 'aac'
  return null
}
