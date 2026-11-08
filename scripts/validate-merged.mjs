import { loadSource, verifyAudioUrl } from './lx-runtime.mjs'
import { PLATFORMS, QUALITIES, sha256, pool } from './source-state.mjs'
import { testOne } from './test-sources.mjs'
import { normalizeProbes } from './probes.mjs'
import { playbackPolicy } from './playback-policy.mjs'
import { boundedNumber } from './http.mjs'

/** Exercise the generated loader, dispatch, fallback and verification in real VMs. */
export async function validateMerged(output, sources, { probes, config = {}, load = loadSource,
  verify = verifyAudioUrl } = {}) {
  const selectedProbes = normalizeProbes(probes)
  const policy = playbackPolicy(config), hash = sha256(output)
  const profiles = []
  for (const profile of ['bytes', 'head']) {
    const expected = Object.fromEntries(PLATFORMS.map(platform => [platform,
      (sources[platform]?.qualitys || []).filter(q => profile === 'bytes' || (q !== 'flac' && q !== 'flac24bit'))])
      .filter(([, qualities]) => qualities.length))
    if (!Object.keys(expected).length) continue
    const rt = await load(output, {
      timeoutMs: Math.min(boundedNumber(config.embed?.initTimeoutMs, 30000) + 5000, 60000),
      callTimeoutMs: Math.min(policy.totalTimeoutMs + 1000, 60000),
      allowCodeGeneration: false, audioProbe: profile === 'bytes',
    })
    try {
      if (rt.error || rt.closed) throw new Error(`Merged ${profile} initialization failed: ${rt.error || 'sandbox closed'}`)
      for (const [platform, qualities] of Object.entries(expected)) {
        if (qualities.some(q => !rt.sources[platform]?.qualitys?.includes(q))) {
          throw new Error(`Merged ${profile} initialization lost verified qualities for ${platform}`)
        }
      }
      const tasks = Object.entries(expected).flatMap(([platform, qualities]) => qualities.flatMap(quality =>
        selectedProbes[platform].map(probe => ({ platform, quality, probe }))))
      const results = await pool(tasks, 2, ({ platform, quality, probe }) => testOne(rt,
        { id: `merged:${profile}`, sha256: hash }, platform, quality, probe, verify, { timeoutMs: policy.verifyTimeoutMs }))
      for (const [platform, qualities] of Object.entries(expected)) for (const quality of qualities) {
        const samples = results.filter(r => r.platform === platform && r.quality === quality)
        if (!samples.some(r => r.l3)) {
          throw new Error(`Merged playback validation failed (${profile} ${platform}/${quality}): ${samples.map(r => r.detail).join(' | ')}`)
        }
      }
      profiles.push({ profile, sources: expected, results })
      console.log(`Merged ${profile}: ${results.filter(r => r.l3).length}/${results.length} playback probes passed`)
    } finally { rt.dispose() }
  }
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), sha256: hash, policy, probes: selectedProbes, profiles }
}

export function playbackMarkdown(report) {
  return [
    `# 整合音源播放验收 ${report.generatedAt}`, '',
    '通过实际整合包的 musicUrl → 子源回退 → 播放校验，再独立 GET 检查音频字节。',
    'bytes 模式使用宿主有界字节探针；head 模式模拟普通受限客户端，仅提供普通音质。',
    'HEAD 本身只检查连通性和明确的错误类型，不能证明音频格式。下表通过数包含验收侧独立的音频字节检查。', '',
    `产物 SHA256：\`${report.sha256}\``, '',
    '| 宿主 | 平台 | 音质 | 通过/曲目数 |', '|---|---|---|---|',
    ...report.profiles.flatMap(({ profile, results }) => PLATFORMS.flatMap(platform => QUALITIES.flatMap(quality => {
      const samples = results.filter(r => r.platform === platform && r.quality === quality)
      return samples.length ? [`| ${profile} | ${platform} | ${quality} | ${samples.filter(r => r.l3).length}/${samples.length} |`] : []
    }))), '',
  ].join('\n')
}
