import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { requestText } from './http.mjs'

export const PLATFORMS = ['wy', 'tx', 'kw', 'kg', 'mg']
export const QUALITIES = ['128k', '320k', 'flac', 'flac24bit']
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')

export function isMain(url) {
  return !!process.argv[1] && url === pathToFileURL(path.resolve(process.argv[1])).href
}

export function parseMeta(script) {
  const comment = script.match(/\/\*!?([\s\S]*?)\*\//)
  const meta = {}
  for (const line of (comment?.[1] || '').split('\n')) {
    const match = line.match(/^\s*\*?\s*@(\w+)\s+(.*)$/)
    if (match) meta[match[1]] = match[2].trim()
  }
  return meta
}

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback
    throw error
  }
}

export async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, content)
    await fs.rename(tmp, file)
  } finally { await fs.rm(tmp, { force: true }) }
}

export async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export function normalizeSources(sources) {
  const out = {}
  for (const platform of PLATFORMS) {
    const source = sources?.[platform]
    if (source?.type !== 'music' || !source.actions?.includes('musicUrl') || !Array.isArray(source.qualitys)) continue
    const qualitys = QUALITIES.filter(q => source.qualitys.includes(q))
    if (qualitys.length) out[platform] = { name: String(source.name || platform), type: 'music', actions: ['musicUrl'], qualitys }
  }
  return out
}

export async function cacheScript(code, cacheDir = '.cache/sources') {
  const hash = sha256(code)
  await atomicWrite(path.join(cacheDir, `${hash}.js`), code)
  return hash
}

export async function readSnapshot(entry, { cacheDir = '.cache/sources', download = requestText } = {}) {
  if (!/^[a-f0-9]{64}$/.test(entry?.sha256 || '')) throw new Error('Missing valid source SHA256; run fetch again')
  const cached = path.join(cacheDir, `${entry.sha256}.js`)
  let code
  try { code = await fs.readFile(cached, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    if (!/^[a-f0-9]{40}$/.test(entry.commit || '') || !entry.url?.includes(`/${entry.commit}/`)) {
      throw new Error('Source URL is not pinned to an immutable commit; run fetch again')
    }
    code = await download(entry.url, { maxBytes: 2097152 })
  }
  if (sha256(code) !== entry.sha256) throw new Error('Source SHA256 mismatch; refusing untested code')
  await atomicWrite(cached, code)
  return code
}
