import fs from 'node:fs/promises'
import vm from 'node:vm'
import { loadSource } from './lx-runtime.mjs'
import { sniffAudio, qualityMatchesAudio, audioContentTypeAllowed } from './audio.mjs'
import { boundedNumber } from './http.mjs'
import { PLATFORMS, QUALITIES, sha256, readSnapshot, parseMeta, normalizeSources,
  readJson, atomicWrite, pool, isMain } from './source-state.mjs'

const PLATFORM_NAMES = { wy: '网易云音乐', tx: 'QQ音乐', kw: '酷我音乐', kg: '酷狗音乐', mg: '咪咕音乐' }
const safeJson = value => JSON.stringify(value, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const commentValue = value => String(value).replace(/\*\//g, '* /').replace(/[\r\n\u2028\u2029]+/g, ' ')

export function validateReport(state, report, { now = Date.now(), maxAgeMs = 86400000 } = {}) {
  if (state?.schemaVersion !== 2 || report?.schemaVersion !== 2 || !state.runId || state.runId !== report.runId) {
    throw new Error('Health report does not match this source snapshot; run fetch and health again')
  }
  const generated = Date.parse(report.generatedAt)
  const fetched = Date.parse(state.lastRun)
  if (!Number.isFinite(generated) || !Number.isFinite(fetched) || generated < fetched ||
    generated > now + 60000 || now - generated > maxAgeMs) throw new Error('Health report is stale or has an invalid timestamp')
  const ids = Object.keys(state.sources || {})
  if (ids.length !== Object.keys(report.sourceHashes || {}).length || ids.some(id =>
    !/^[a-f0-9]{64}$/.test(state.sources[id].sha256 || '') || state.sources[id].sha256 !== report.sourceHashes[id])) {
    throw new Error('Source hashes changed since the health check')
  }
  if (!Array.isArray(report.results) || !report.results.length) throw new Error('Health report has no results')
  if (report.results.length !== ids.length * PLATFORMS.length * QUALITIES.length) {
    throw new Error('Health report has an incomplete source/platform/quality matrix')
  }
  const seen = new Set()
  for (const result of report.results) {
    if (!result || typeof result.source !== 'string' || !Object.hasOwn(state.sources, result.source) ||
      result.sha256 !== state.sources[result.source].sha256 ||
      !PLATFORMS.includes(result.platform) || !QUALITIES.includes(result.quality)) {
      throw new Error('Invalid or unverified health result')
    }
    if (['l1', 'l2', 'l3'].some(key => typeof result[key] !== 'boolean') ||
      (result.skipped !== undefined && typeof result.skipped !== 'boolean')) {
      throw new Error('Health result flags must be boolean')
    }
    if ((result.l2 && !result.l1) || (result.l3 && !result.l2) ||
      (result.skipped && (result.l1 || result.l2 || result.l3))) {
      throw new Error('Inconsistent L1/L2/L3 health result')
    }
    const key = JSON.stringify([result.source, result.platform, result.quality])
    if (seen.has(key)) throw new Error('Duplicate source/platform/quality health result')
    seen.add(key)
  }
}

export function buildDeclarations(subs) {
  const sources = {}
  for (const p of PLATFORMS) {
    const qualitys = QUALITIES.filter(q => subs.some(s => s.healthy[p]?.includes(q)))
    if (qualitys.length) sources[p] = { name: PLATFORM_NAMES[p], type: 'music', actions: ['musicUrl'], qualitys }
  }
  return sources
}

export function renderSource(template, subs, config = {}, generatedAt = new Date().toISOString()) {
  const sources = buildDeclarations(subs)
  if (!Object.keys(sources).length) throw new Error('No verified platform/quality combinations')
  const values = {
    NAME: commentValue(config.name || '聚合音源'),
    DESCRIPTION: commentValue(config.description || `内嵌 ${subs.length} 个可用音源`),
    VERSION: commentValue(config.version || generatedAt.slice(0, 10)),
    AUTHOR: commentValue(config.author || 'hellomrli'), HOMEPAGE: commentValue(config.homepage || ''),
    GENERATED_AT: commentValue(generatedAt), SUB_NAMES: commentValue(subs.map(s => s.name).join(' / ')),
    SUBS_JSON: safeJson(subs), SOURCES_JSON: safeJson(sources),
    // Function literals are parsed with the script, even when runtime eval/Function is disabled.
    SUB_RUNNERS: '[\n' + subs.map(sub => 'function(scope) {\nwith (scope) {\nreturn (function() {\n' +
      sub.code + '\n}).call(this)\n}\n}').join(',\n') + '\n]',
    INIT_TIMEOUT_MS: String(boundedNumber(config.embed?.initTimeoutMs, 30000)),
    REQUEST_TIMEOUT_MS: String(boundedNumber(config.embed?.requestTimeoutMs, 12000)),
    TOTAL_TIMEOUT_MS: String(boundedNumber(config.embed?.totalTimeoutMs, 45000)),
    VERIFY_TIMEOUT_MS: String(boundedNumber(config.embed?.verifyTimeoutMs, 8000)),
    AUDIO_HELPERS: [sniffAudio, qualityMatchesAudio, audioContentTypeAllowed].map(fn => fn.toString()).join('\n\n'),
  }
  const script = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`Unknown template placeholder ${key}`)
    return values[key]
  })
  new vm.Script(script, { filename: 'merged-source.js' })
  return script
}

export async function buildSource({ statePath = 'state.json', reportPath = 'reports/health.json',
  outputPath = 'dist/merged-source.js', templatePath = 'templates/merged-source.js',
  cacheDir = '.cache/sources', config, load = loadSource, now = Date.now() } = {}) {
  const cfg = config || await readJson('config.json', {})
  if ((cfg.mode || 'embed') !== 'embed') throw new Error('Only embed mode is supported')
  const state = await readJson(statePath), report = await readJson(reportPath)
  validateReport(state, report, { now, maxAgeMs: boundedNumber(cfg.embed?.maxReportAgeMs, 86400000, 1, 86400000) })
  const healthy = new Map()
  for (const result of report.results) {
    if (!result.l3) continue
    // Aliases of identical code share one initialization and one source-limit slot.
    const hash = state.sources[result.source].sha256
    let item = healthy.get(hash)
    if (!item) { item = { id: result.source, healthy: {} }; healthy.set(hash, item) }
    else if (result.source.localeCompare(item.id) < 0) item.id = result.source
    const qualitys = item.healthy[result.platform] ||= []
    if (!qualitys.includes(result.quality)) qualitys.push(result.quality)
  }
  const candidates = [...healthy.values()].sort((a, b) => Object.keys(b.healthy).length - Object.keys(a.healthy).length ||
    Object.values(b.healthy).flat().length - Object.values(a.healthy).flat().length || a.id.localeCompare(b.id))
  const maxSources = boundedNumber(cfg.embed?.maxSources, 0, 1, 40)
  // A sub-source appears twice in the artifact (metadata and runner), so budget by its source size.
  const maxEmbedBytes = boundedNumber(cfg.embed?.maxEmbedBytes, 0, 0, 8 * 1024 * 1024)
  const maxSourceBytes = boundedNumber(cfg.embed?.maxSourceBytes, 0, 0, 8 * 1024 * 1024)
  if (!candidates.length) throw new Error('No L3-passing sources; previous artifact preserved')
  const loaded = await pool(candidates, 3, async candidate => {
    let rt
    try {
      const entry = state.sources[candidate.id]
      const code = await readSnapshot(entry, { cacheDir })
      rt = await load(code, { timeoutMs: boundedNumber(cfg.embed?.probeTimeoutMs, 15000), allowCodeGeneration: false })
      if (rt.error || rt.closed) throw new Error(`Build-time initialization failed: ${rt.error || 'sandbox closed'}`)
      const declared = normalizeSources(rt.sources)
      const verified = {}
      for (const p of PLATFORMS) {
        const qualitys = QUALITIES.filter(q => candidate.healthy[p]?.includes(q) && declared[p]?.qualitys.includes(q))
        if (qualitys.length) verified[p] = qualitys
      }
      if (!Object.keys(verified).length) throw new Error('No health-tested qualities are still declared')
      const meta = parseMeta(code)
      return { key: candidate.id, name: meta.name || entry.name || candidate.id, version: meta.version || '',
        description: meta.description || '', author: meta.author || '', homepage: meta.homepage || '',
        sha256: sha256(code), bytes: Buffer.byteLength(code), healthy: verified, code }
    } catch (error) { console.warn(`Skipping ${candidate.id}: ${error.message}`); return null }
    finally { rt?.dispose() }
  })
  const subs = []
  let embedBytes = 0
  for (const sub of loaded.filter(Boolean)) {
    if (maxSources && subs.length >= maxSources) break
    if (maxSourceBytes && sub.bytes > maxSourceBytes) {
      console.warn(`Skipping ${sub.key}: per-source budget exceeded`)
      continue
    }
    if (maxEmbedBytes && embedBytes + sub.bytes > maxEmbedBytes) {
      console.warn(`Skipping ${sub.key}: embedded source budget exceeded`)
      continue
    }
    subs.push(sub)
    embedBytes += sub.bytes
  }
  if (!subs.length) throw new Error('All candidate sources failed validation; previous artifact preserved')
  for (const sub of subs) delete sub.bytes
  const template = await fs.readFile(templatePath, 'utf8')
  const output = renderSource(template, subs, cfg, new Date(now).toISOString())
  // Syntax alone cannot detect a broken loader/shim. Load the actual merged artifact before publishing it.
  const combined = await load(output, { timeoutMs: Math.min(boundedNumber(cfg.embed?.initTimeoutMs, 30000) + 5000, 60000),
    allowCodeGeneration: false })
  try {
    if (combined.error || combined.closed || !Object.keys(combined.sources).length) {
      throw new Error(`Merged source validation failed: ${combined.error || 'no live sources'}`)
    }
  } finally { combined.dispose() }
  await atomicWrite(outputPath, output)
  console.log(`Built ${subs.length} sources, ${Object.keys(buildDeclarations(subs)).length} verified platforms, ${Buffer.byteLength(output)} bytes`)
  return { subs, sources: buildDeclarations(subs), output }
}

if (isMain(import.meta.url)) {
  try { await buildSource() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
