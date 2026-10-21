import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { boundedNumber, requestBytes, parseHttpUrl } from './http.mjs'
import { parseMeta, normalizeSources } from './source-state.mjs'
import { sniffAudio, qualityMatchesAudio, audioContentTypeAllowed } from './audio.mjs'

export { parseMeta, sniffAudio }

export function sandboxCommand() {
  if (process.platform !== 'linux') throw new Error('Source execution requires Linux and bubblewrap; no unsafe fallback')
  const node = fs.realpathSync(process.execPath)
  const worker = fileURLToPath(new URL('./lx-worker.mjs', import.meta.url))
  const args = [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
  ]
  for (const dir of ['/lib', '/lib64', '/usr/lib', '/usr/lib64']) args.push('--ro-bind-try', dir, dir)
  const nodeResources = ['/usr/share/nodejs', '/usr/share/node_modules'].filter(dir => fs.existsSync(dir))
  for (const dir of nodeResources) args.push('--ro-bind', dir, dir)
  args.push('--proc', '/proc', '--dev', '/dev', '--size', '16777216', '--tmpfs', '/tmp',
    '--dir', '/runner', '--ro-bind', node, '/runner/node', '--ro-bind', worker, '/runner/worker.mjs',
    '--chdir', '/runner', '--setenv', 'HOME', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
    '/runner/node', Number(process.versions.node.split('.')[0]) >= 22 ? '--permission' : '--experimental-permission',
    '--allow-fs-read=/runner', ...nodeResources.map(dir => `--allow-fs-read=${dir}`),
    '--no-addons', '--jitless', '--max-old-space-size=96', '--stack-size=512', '/runner/worker.mjs')
  return { command: '/usr/bin/prlimit', args: [
    '--core=0', '--data=536870912', '--cpu=300', '--nofile=128', '--', '/usr/bin/bwrap', ...args,
  ] }
}

function encodeBody(options, headers) {
  let body = options.body
  if (options.form) {
    body = new URLSearchParams(options.form).toString()
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
  } else if (options.formData) {
    throw new Error('Multipart formData is not supported by the inspection broker')
  } else if (body?.type === 'Buffer' && Array.isArray(body.data)) body = Buffer.from(body.data)
  else if (body && typeof body === 'object') {
    body = JSON.stringify(body)
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
  }
  if (body !== undefined && Buffer.byteLength(body) > 1048576) throw new Error('HTTP request body too large')
  return body
}

/** The VM is only an API shim; OS namespaces and the HTTP broker form the security boundary. */
export async function loadSource(script, { timeoutMs = 30000, allowPrivateNetwork = false, allowCodeGeneration = true } = {}) {
  const meta = parseMeta(script)
  const timeout = boundedNumber(timeoutMs, 30000)
  let child
  try {
    if (Buffer.byteLength(script) > 2097152) throw new Error('Source script exceeds 2 MiB')
    const { command, args } = sandboxCommand()
    child = spawn(command, args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) { return { meta, sources: {}, error: error.message, callMusicUrl: null, dispose() {} } }

  const pending = new Map(), requests = new Map()
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let closed = false, counter = 0, output = '', stderr = '', messageCount = 0, started = false
  const send = message => {
    if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify(message) + '\n')
  }
  const stop = error => {
    if (closed) return
    closed = true
    clearTimeout(lifetime)
    for (const controller of requests.values()) controller.abort()
    requests.clear()
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error || new Error('Source disposed')) }
    pending.clear()
    child.stdin.destroy()
    child.kill('SIGKILL')
  }
  const lifetime = setTimeout(() => stop(new Error('Sandbox lifetime exceeded')), 600000)
  const rpc = (type, data, deadline = timeout) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Source sandbox is closed')); return }
    const id = ++counter
    const item = { resolve, reject, type, deadline }
    item.timer = setTimeout(() => stop(new Error(`${type} timeout`)), type === 'load' ? 10000 : deadline)
    pending.set(id, item)
    send({ type, id, ...data })
  })
  async function broker(message) {
    const id = message.id
    if (!Number.isSafeInteger(id) || id < 1 || requests.has(id) || requests.size >= 16) {
      send({ type: 'httpResult', id, error: 'Too many concurrent HTTP requests' })
      return
    }
    const controller = new AbortController()
    requests.set(id, controller)
    try {
      const options = message.options || {}
      const headers = { ...options.headers }
      const body = encodeBody(options, headers)
      const response = await requestBytes(message.url, {
        method: options.method || 'GET', headers, body, signal: controller.signal,
        timeoutMs: boundedNumber(options.timeout, 20000, 1, 20000),
        maxBytes: 1048576, allowPrivateNetwork,
      })
      send({ type: 'httpResult', id, response: {
        statusCode: response.statusCode, headers: response.headers, url: response.url,
        raw: response.raw.toString('base64'),
      } })
    } catch (error) { send({ type: 'httpResult', id, error: error.message }) }
    finally { requests.delete(id) }
  }
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 2048) })
  child.once('error', error => stop(new Error(`OS sandbox unavailable: ${error.message}`)))
  child.once('exit', (code, signal) => stop(new Error(`Sandbox exited (${signal || code}): ${stderr.slice(0, 400)}`)))
  child.stdin.on('error', error => stop(error))
  child.stdout.on('data', chunk => {
    if (closed) return
    output += chunk
    if (output.length > 4194304) { stop(new Error('Sandbox IPC message too large')); return }
    let newline
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline)
      output = output.slice(newline + 1)
      let message
      try { message = JSON.parse(line) } catch { stop(new Error('Invalid sandbox IPC')); return }
      if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
        stop(new Error('Invalid sandbox IPC message shape')); return
      }
      if (++messageCount > 4096) { stop(new Error('Sandbox IPC quota exceeded')); return }
      if (message.type === 'started' && !started) {
        started = true
        for (const item of pending.values()) if (item.type === 'load') {
          clearTimeout(item.timer)
          item.timer = setTimeout(() => stop(new Error('Source initialization timeout')), item.deadline)
        }
      } else if (message.type === 'http') void broker(message)
      else if (message.type === 'cancelHttp') requests.get(message.id)?.abort()
      else if (message.type === 'fatal') stop(new Error(`Source failed: ${String(message.error).slice(0, 300)}`))
      else if (message.type === 'result') {
        const item = pending.get(message.id)
        if (!item) continue
        clearTimeout(item.timer)
        pending.delete(message.id)
        if (message.error) item.reject(new Error(String(message.error)))
        else item.resolve(message.value)
      }
    }
  })
  try {
    const declared = await rpc('load', { script, meta, timeoutMs: timeout, allowCodeGeneration })
    const sources = normalizeSources(declared)
    return {
      meta, sources, error: null,
      get closed() { return closed },
      callMusicUrl: (source, musicInfo, quality) => rpc('call', { source, musicInfo, quality }),
      dispose: () => stop(),
    }
  } catch (error) {
    stop(error)
    return { meta, sources: {}, error: error.message, callMusicUrl: null, dispose() {} }
  }
}

export async function verifyAudioUrl(url, { timeoutMs = 20000, maxBytes = 4096, quality,
  allowPrivateNetwork = false } = {}) {
  try {
    parseHttpUrl(url)
    const response = await requestBytes(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Range: `bytes=0-${maxBytes - 1}` },
      timeoutMs, maxBytes, prefix: true, allowPrivateNetwork,
    })
    const ct = String(response.headers['content-type'] || '').toLowerCase()
    const magic = sniffAudio(response.raw)
    const connected = response.statusCode === 200 || response.statusCode === 206
    const qualityOk = qualityMatchesAudio(quality, magic, response.raw)
    return {
      ok: connected && magic !== null && audioContentTypeAllowed(ct) && qualityOk,
      connected, status: response.statusCode, contentType: ct, magic, qualityOk,
      ctOk: /^audio\//.test(ct), bytes: response.raw.length,
    }
  } catch (error) {
    return { ok: false, connected: false, status: 0, error: error.message, magic: null, ctOk: false, bytes: 0 }
  }
}
