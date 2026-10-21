import { loadSource, verifyAudioUrl } from './lx-runtime.mjs'
import { parseHttpUrl, boundedNumber } from './http.mjs'
import { PLATFORMS, QUALITIES, readJson, readSnapshot, pool, atomicWrite, isMain } from './source-state.mjs'

export const PROBES = {
  wy: { source: 'wy', musicInfo: { songmid: '2652820720', name: '晴天(深情版)', singer: 'Lucky小爱', source: 'wy', interval: '04:38' } },
  tx: { source: 'tx', musicInfo: { songmid: '0039MnYb0qxYhV', name: '晴天', singer: '周杰伦', source: 'tx', interval: '04:29' } },
  kw: { source: 'kw', musicInfo: { songmid: '228908', name: '晴天', singer: '周杰伦', source: 'kw', interval: '04:29' } },
  kg: { source: 'kg', musicInfo: { songmid: 'B3A52A7A958BF0AED0EBFBA2E9A818B7', hash: 'B3A52A7A958BF0AED0EBFBA2E9A818B7', name: '晴天', singer: '周杰伦', source: 'kg', interval: '04:29' } },
  mg: { source: 'mg', musicInfo: { songmid: '3790007', copyrightId: '60054701923', name: '晴天', singer: '周杰伦', source: 'mg', interval: '04:30' } },
}

const safeDetail = value => String(value).replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]').slice(0, 240)

export async function testOne(rt, { id, sha256 }, platform, quality, probe, verify = verifyAudioUrl, verifyOptions = {}) {
  const result = { source: id, sha256, platform, quality, l1: false, l2: false, l3: false, detail: '' }
  if (rt.error) { result.detail = safeDetail(`L0 ${rt.error}`); return result }
  if (!rt.sources?.[platform]?.qualitys.includes(quality)) {
    result.skipped = true
    result.detail = 'Platform or quality not declared'
    return result
  }
  try {
    const url = await rt.callMusicUrl(platform, structuredClone(probe.musicInfo), quality)
    parseHttpUrl(url)
    result.l1 = true
    const checked = await verify(url, { ...verifyOptions, quality })
    result.l2 = checked.connected === true
    result.l3 = checked.ok === true
    result.detail = safeDetail(checked.ok ? `OK ${checked.status} ${checked.magic} ${checked.bytes}B` :
      `HTTP ${checked.status} ct=${checked.contentType || '-'} magic=${checked.magic || '-'}${checked.qualityOk === false ? ' quality mismatch' : ''}${checked.error ? ' ' + checked.error : ''}`)
  } catch (error) { result.detail = safeDetail(`L1 ${error.message || error}`) }
  return result
}

export function summarize(results) {
  const sources = new Map()
  for (const result of results) {
    let summary = sources.get(result.source)
    if (!summary) {
      summary = { source: result.source, platforms: {}, l3Count: 0 }
      sources.set(result.source, summary)
    }
    const platform = summary.platforms[result.platform] ||= { l3: false, qualitys: [] }
    if (result.l3) {
      if (!platform.l3) { platform.l3 = true; summary.l3Count++ }
      if (!platform.qualitys.includes(result.quality)) platform.qualitys.push(result.quality)
    }
  }
  return [...sources.values()].sort((a, b) => b.l3Count - a.l3Count || a.source.localeCompare(b.source))
}

const markdownCell = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
export function healthMarkdown(report) {
  return [
    `# 音源可用性巡检 ${report.generatedAt} UTC`, '',
    '只表示探针曲目可用，不保证所有曲目。每个平台独立检测 128k / 320k / flac / flac24bit；无损请求会校验 FLAC 格式，24-bit 还会校验位深。', '',
    '| 音源 | wy | tx | kw | kg | mg | 可用平台 |',
    '|---|---|---|---|---|---|---|',
    ...report.summary.map(item => `| ${markdownCell(item.source)} | ${PLATFORMS.map(p => item.platforms[p]?.qualitys.join(', ') || '-').join(' | ')} | ${item.l3Count}/5 |`),
    '', '## 明细', '',
    '| 音源 | 平台 | 音质 | L1 | L2 | L3 | 说明 |', '|---|---|---|---|---|---|---|',
    ...report.results.map(r => `| ${markdownCell(r.source)} | ${r.platform} | ${r.quality} | ${r.l1 ? 'OK' : '-'} | ${r.l2 ? 'OK' : '-'} | ${r.l3 ? 'OK' : '-'} | ${markdownCell(r.detail)} |`), '',
  ].join('\n')
}

export async function runHealth({ statePath = 'state.json', reportPath = 'reports/health.json',
  markdownPath = 'reports/health.md', cacheDir = '.cache/sources', load = loadSource,
  verify = verifyAudioUrl, probes, config } = {}) {
  const cfg = config || await readJson('config.json', {})
  const state = await readJson(statePath)
  if (state.schemaVersion !== 2 || !state.runId || !Object.keys(state.sources || {}).length) {
    throw new Error('Missing immutable source state; run npm run fetch first')
  }
  const selectedProbes = probes || cfg.health?.probes || PROBES
  for (const p of PLATFORMS) {
    if (!selectedProbes[p]?.musicInfo?.songmid || (p === 'kg' && !selectedProbes[p].musicInfo.hash) ||
      (p === 'mg' && !selectedProbes[p].musicInfo.copyrightId)) throw new Error(`Incomplete probe metadata for ${p}`)
  }
  const timeoutMs = boundedNumber(cfg.health?.requestTimeoutMs, 12000)
  const runtimeOptions = { timeoutMs, allowCodeGeneration: false }
  const verifyTimeout = boundedNumber(cfg.health?.verifyTimeoutMs, 10000)
  const concurrency = boundedNumber(cfg.health?.concurrency, 4, 1, 8)
  const preflight = await load("lx.send('inited', { sources: {} })", { timeoutMs: 2000, allowCodeGeneration: false })
  preflight.dispose()
  if (preflight.error) throw new Error(`OS sandbox preflight failed: ${preflight.error}`)
  const declarations = {}, sourceHashes = {}
  const outputs = await pool(Object.entries(state.sources), concurrency, async ([id, entry]) => {
    sourceHashes[id] = entry.sha256
    let code, rt
    const results = []
    try {
      code = await readSnapshot(entry, { cacheDir })
      rt = await load(code, runtimeOptions)
      if (!rt.error) declarations[id] = rt.sources
    } catch (error) { rt = { error: error.message, sources: {}, dispose() {} } }
    try {
      // Keep healthy qualities useful even if another quality wedges its disposable process.
      for (const platform of PLATFORMS) for (const quality of ['320k', '128k', 'flac', 'flac24bit']) {
        if (rt.closed && code) { rt.dispose(); rt = await load(code, runtimeOptions) }
        const result = await testOne(rt, { id, sha256: entry.sha256 }, platform, quality,
          selectedProbes[platform], verify, { timeoutMs: verifyTimeout })
        results.push(result)
      }
      console.log(`${id}: ${results.filter(r => r.l3).length} healthy platform/quality combinations`)
      return results
    } finally { rt.dispose() }
  })
  const results = outputs.flat()
  const report = { schemaVersion: 2, runId: state.runId, generatedAt: new Date().toISOString(),
    qualities: QUALITIES, probes: selectedProbes, sourceHashes, declarations, results, summary: summarize(results) }
  await atomicWrite(reportPath, JSON.stringify(report, null, 2) + '\n')
  await atomicWrite(markdownPath, healthMarkdown(report))
  if (!results.some(r => r.l3)) throw new Error('No healthy sources; preserving previous published artifact')
  return report
}

if (isMain(import.meta.url)) {
  try { await runHealth() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
