import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { renderSource } from '../scripts/build-source.mjs'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const mp3 = () => Buffer.concat([Buffer.from([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(4086)])
export function flac(bits = 16) {
  const bytes = Buffer.alloc(4096)
  bytes.write('fLaC')
  bytes[4] = 128
  bytes[7] = 34
  bytes[20] = ((bits - 1) >> 4) & 1
  bytes[21] = ((bits - 1) & 15) << 4
  return bytes
}
export const sourceCode = (body, qualitys = ['320k'], platform = 'wy') => `
  const {on,send,EVENT_NAMES}=globalThis.lx;
  on(EVENT_NAMES.request,async(input)=>{${body}});
  send(EVENT_NAMES.inited,{sources:{${platform}:{type:'music',actions:['musicUrl'],qualitys:${JSON.stringify(qualitys)}}}});
`
export const sub = (key, code, healthy = { wy: ['320k'] }) => ({ key, name: key, code, healthy })

export async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'my-lxsource-test-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

export async function server(t, handler) {
  const instance = http.createServer(handler)
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    instance.closeAllConnections()
    await new Promise(resolve => instance.close(resolve))
  })
  return `http://127.0.0.1:${instance.address().port}`
}

export async function mergedHarness(t, subs, { request, fetch, utils = {}, config, globals = {}, allowCodeGeneration = false } = {}) {
  const timers = new Set(), handlers = []
  let initialized
  const ready = new Promise(resolve => { initialized = resolve })
  const lx = {
    version: 2, env: 'desktop', platform: 'linux', utils,
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    on: (event, handler) => { if (event === 'request') handlers.push(handler) },
    send: (event, data) => { if (event === 'inited') initialized(data); return Promise.resolve() },
    request: request || ((url, options, callback) => {
      const id = setTimeout(() => callback(null, { statusCode: url.includes('dead') ? 404 : 200,
        headers: { 'content-type': 'audio/mpeg' } }), 0)
      return () => clearTimeout(id)
    }),
  }
  const context = vm.createContext({ lx, URL,
    ...(fetch ? { fetch, AbortController, ReadableStream } : {}), ...globals,
    setTimeout: (fn, ms, ...args) => {
      const id = setTimeout(() => { timers.delete(id); fn(...args) }, ms)
      timers.add(id)
      return id
    },
    clearTimeout: id => { clearTimeout(id); timers.delete(id) },
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); timers.add(id); return id },
    clearInterval: id => { clearInterval(id); timers.delete(id) },
  }, { codeGeneration: { strings: allowCodeGeneration, wasm: false } })
  t.after(() => { for (const id of timers) { clearTimeout(id); clearInterval(id) } })
  const template = await fs.readFile(path.join(ROOT, 'templates/merged-source.js'), 'utf8')
  const script = renderSource(template, subs, { embed: { initTimeoutMs: 60, requestTimeoutMs: 80,
    totalTimeoutMs: 300, verifyTimeoutMs: 50 }, ...config })
  new vm.Script(script).runInContext(context, { timeout: 1000 })
  const inited = await Promise.race([ready, new Promise((_, reject) => {
    const id = setTimeout(() => reject(new Error('Harness initialization timed out')), 500)
    timers.add(id)
  })])
  return { context, lx, inited, call: (source = 'wy', quality = '320k', musicInfo = {}) =>
    handlers[0]({ source, action: 'musicUrl', info: { type: quality, musicInfo } }) }
}
