import vm from 'node:vm'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import readline from 'node:readline'

const write = process.stdout.write.bind(process.stdout)
const send = message => write(JSON.stringify(message) + '\n')
const fatal = error => { send({ type: 'fatal', error: String(error?.message || error) }); process.exit(1) }
// These handlers exist only in the disposable sandbox process, never in the trusted broker.
process.on('unhandledRejection', fatal)
process.on('uncaughtException', fatal)

let context, loadId, inited = false, evaluationDone = false, declared, timeoutMs = 30000, requestId = 0
const callbacks = new Map(), timers = new Map(), requests = []
const EVENT_NAMES = Object.freeze({ inited: 'inited', request: 'request', updateAlert: 'updateAlert' })
const noop = () => {}
// Source scripts may use the standard browser/Node console API during initialization.
const consoleShim = Object.fromEntries([
  'assert', 'clear', 'count', 'countReset', 'debug', 'dir', 'dirxml', 'error', 'group',
  'groupCollapsed', 'groupEnd', 'info', 'log', 'profile', 'profileEnd', 'table', 'time',
  'timeEnd', 'timeLog', 'trace', 'warn',
].map(method => [method, noop]))

function httpRequest(url, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  if (typeof callback !== 'function') throw new Error('Missing HTTP callback')
  const id = ++requestId
  callbacks.set(id, callback)
  send({ type: 'http', id, url, options: options || {} })
  return () => { callbacks.delete(id); send({ type: 'cancelHttp', id }) }
}

function schedule(callback, delay, repeat, ...args) {
  if (timers.size >= 256) throw new Error('Timer quota exceeded')
  const fn = () => {
    if (!repeat) timers.delete(id)
    try { callback(...args) } catch (error) { fatal(error) }
  }
  const id = repeat ? setInterval(fn, Math.max(10, Number(delay) || 0)) : setTimeout(fn, Number(delay) || 0)
  timers.set(id, repeat)
  return id
}
const cancelTimer = id => { clearTimeout(id); clearInterval(id); timers.delete(id) }

function load(message) {
  loadId = message.id
  timeoutMs = message.timeoutMs
  send({ type: 'started' })
  const lx = {
    version: 2, env: 'desktop', platform: 'linux', EVENT_NAMES,
    currentScriptInfo: { ...message.meta, rawScript: message.script },
    request: httpRequest,
    on(event, handler) { if (event === EVENT_NAMES.request && typeof handler === 'function') requests.push(handler) },
    send(event, data) {
      if (event === EVENT_NAMES.inited && !inited) {
        inited = true
        declared = data?.sources || {}
        if (evaluationDone) send({ type: 'result', id: loadId, value: declared })
      }
      return Promise.resolve()
    },
    utils: {
      buffer: { from: (v, enc) => Buffer.from(v, enc), bufToString: (b, enc) => Buffer.from(b).toString(enc) },
      crypto: {
        md5: value => crypto.createHash('md5').update(value).digest('hex'),
        randomBytes: size => crypto.randomBytes(size).toString('hex'),
        aesEncrypt: (value, mode, key, iv) => {
          const cipher = crypto.createCipheriv(mode, Buffer.from(key), iv ? Buffer.from(iv) : null)
          return Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()])
        },
        rsaEncrypt: (value, key) => crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(value)),
      },
      zlib: {
        inflate: value => new Promise((resolve, reject) => zlib.inflate(Buffer.from(value), { maxOutputLength: 1048576 },
          (error, result) => error ? reject(error) : resolve(result))),
        deflate: value => new Promise((resolve, reject) => zlib.deflate(Buffer.from(value),
          (error, result) => error ? reject(error) : resolve(result))),
      },
    },
  }
  const globals = {
    lx, console: consoleShim,
    setTimeout: (fn, ms, ...args) => schedule(fn, ms, false, ...args),
    setInterval: (fn, ms, ...args) => schedule(fn, ms, true, ...args),
    clearTimeout: cancelTimer, clearInterval: cancelTimer,
    Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
  }
  context = vm.createContext(globals, { codeGeneration: { strings: message.allowCodeGeneration !== false, wasm: false } })
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis; globalThis.global = globalThis', context)
  new vm.Script(message.script, { filename: 'source.js' }).runInContext(context, { timeout: timeoutMs })
  evaluationDone = true
  if (inited) send({ type: 'result', id: loadId, value: declared })
}

async function handle(message) {
  if (message.type === 'load') {
    if (context) throw new Error('Source already loaded')
    load(message)
  } else if (message.type === 'call') {
    try {
      if (!inited || !requests[0]) throw new Error('Source not initialized or missing request handler')
      context.__request = requests[0]
      context.__input = { source: message.source, action: 'musicUrl', info: { type: message.quality, musicInfo: message.musicInfo } }
      const result = vm.runInContext('__request(__input)', context, { timeout: timeoutMs })
      if (!result || typeof result.then !== 'function') throw new Error('Handler must return a Promise')
      send({ type: 'result', id: message.id, value: await result })
    } catch (error) { send({ type: 'result', id: message.id, error: error.message }) }
  } else if (message.type === 'httpResult') {
    const callback = callbacks.get(message.id)
    callbacks.delete(message.id)
    if (!callback) return
    if (message.error) { callback(new Error(message.error), null, null); return }
    const data = message.response
    const raw = Buffer.from(data.raw, 'base64')
    const text = raw.toString('utf8')
    let body = text
    try { body = JSON.parse(text) } catch {}
    const response = { ...data, raw, rawBody: text, body, bytes: raw.length }
    callback(null, response, body)
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line.length > 4194304) { fatal(new Error('Input quota exceeded')); return }
  try { void handle(JSON.parse(line)).catch(fatal) } catch (error) { fatal(error) }
})
input.once('close', () => process.exit(0))
