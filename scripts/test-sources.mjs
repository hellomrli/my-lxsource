import { loadSource, verifyAudioUrl } from './lx-runtime.mjs'
import { parseHttpUrl, boundedNumber } from './http.mjs'
import { PLATFORMS, QUALITIES, readJson, readSnapshot, pool, atomicWrite, isMain } from './source-state.mjs'
import { PROBES, normalizeProbes } from './probes.mjs'
import { playbackPolicy } from './playback-policy.mjs'
export { PROBES }

const safeDetail = value => String(value).replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]').slice(0, 240)

export async function testOne(rt, { id, sha256 }, platform, quality, probe, verify = verifyAudioUrl, verifyOptions = {}) {
  const result = { source: id, sha256, platform, quality, probeId: probe.id || `${platform}:${probe.musicInfo.songmid}`,
    l1: false, l2: false, l3: false, detail: '' }
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
      summary = { source: result.source, platforms: {}, l3Count: 0, passed: 0, checked: 0 }
      sources.set(result.source, summary)
    }
    const platform = summary.platforms[result.platform] ||= { l3: false, qualitys: [], samples: {} }
    const sample = platform.samples[result.quality] ||= { passed: 0, checked: 0 }
    if (!result.skipped) { sample.checked++; summary.checked++ }
    if (result.l3) {
      sample.passed++; summary.passed++
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
    '每个平台检测多首不同歌手的歌曲。音质后的数字为通过曲目数/检测曲目数；部分通过不代表整个曲库可用。无损校验 FLAC 格式，24-bit 还会校验位深。', '',
    `检测预算：取地址 ${report.policy.requestTimeoutMs}ms，音频校验 ${report.policy.verifyTimeoutMs}ms；与客户端一致。`, '',
    '| 音源 | wy | tx | kw | kg | mg | 可用平台 |',
    '|---|---|---|---|---|---|---|',
    ...report.summary.map(item => `| ${markdownCell(item.source)} | ${PLATFORMS.map(p => item.platforms[p]?.qualitys.map(q => {
      const samples = item.platforms[p].samples[q]
      return `${q} (${samples.passed}/${samples.checked})`
    }).join(', ') || '-').join(' | ')} | ${item.l3Count}/5 |`),
    '', '## 明细', '',
    '| 音源 | 平台 | 音质 | 探针 | L1 | L2 | L3 | 说明 |', '|---|---|---|---|---|---|---|---|',
    ...report.results.map(r => `| ${markdownCell(r.source)} | ${r.platform} | ${r.quality} | ${markdownCell(r.probeId)} | ${r.l1 ? 'OK' : '-'} | ${r.l2 ? 'OK' : '-'} | ${r.l3 ? 'OK' : '-'} | ${markdownCell(r.detail)} |`), '',
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
  const selectedProbes = normalizeProbes(probes || cfg.health?.probes || PROBES)
  const policy = playbackPolicy(cfg)
  const timeoutMs = policy.requestTimeoutMs
  const runtimeOptions = { timeoutMs, allowCodeGeneration: false }
  const verifyTimeout = policy.verifyTimeoutMs
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
      for (const platform of PLATFORMS) for (const quality of ['320k', '128k', 'flac', 'flac24bit']) for (const probe of selectedProbes[platform]) {
        if (rt.closed && code) { rt.dispose(); rt = await load(code, runtimeOptions) }
        const result = await testOne(rt, { id, sha256: entry.sha256 }, platform, quality,
          probe, verify, { timeoutMs: verifyTimeout })
        results.push(result)
      }
      console.log(`${id}: ${results.filter(r => r.l3).length}/${results.filter(r => !r.skipped).length} probe checks passed`)
      return results
    } finally { rt.dispose() }
  })
  const results = outputs.flat()
  const report = { schemaVersion: 3, runId: state.runId, generatedAt: new Date().toISOString(), policy,
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
