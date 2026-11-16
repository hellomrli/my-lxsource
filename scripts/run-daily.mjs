import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { UNAVAILABLE_EXIT_CODE } from './availability.mjs'
import { validateReport } from './build-source.mjs'
import { boundedNumber } from './http.mjs'
import { playbackPolicy } from './playback-policy.mjs'
import { normalizeProbes } from './probes.mjs'
import { safeDetail } from './test-sources.mjs'
import { PLATFORMS, QUALITIES, sha256, readJson, atomicWrite, isMain } from './source-state.mjs'

const STAGES = [
  { name: 'fetch', label: '抓取上游', script: 'fetch-upstream.mjs', retries: [2000, 5000] },
  { name: 'health', label: '音源巡检', script: 'test-sources.mjs', retries: [] },
  { name: 'build', label: '构建与播放验收', script: 'build-source.mjs', retries: [5000] },
]

/** Each stage gets its own process; source inspection does not inherit the API token. */
function runStage(name, { cwd, env }) {
  const stage = STAGES.find(stage => stage.name === name)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(cwd, 'scripts', stage.script)], {
      cwd, env, stdio: ['ignore', 'inherit', 'pipe'],
    })
    let detail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk)
      detail = (detail + chunk).slice(-8192)
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, detail: detail.trim() }))
  })
}

async function artifactInfo(file) {
  let bytes
  try { bytes = await fs.readFile(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const generatedAt = bytes.subarray(0, 2048).toString('utf8').match(/^\s*\* Generated at: (\S+)/m)?.[1]
  return { sha256: sha256(bytes), bytes: bytes.length,
    generatedAt: Number.isFinite(Date.parse(generatedAt)) ? generatedAt : null }
}

function requireFresh(value, since, now, label) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp < since || timestamp > now + 60000) {
    throw new Error(`${label} is stale or has an invalid timestamp`)
  }
}

/** Check the publication gate without trusting an old report or an exit code alone. */
function checkPlayback(report, health, config, { since, now, ok, hash }) {
  if (report?.schemaVersion !== 1 || report.ok !== ok || !/^[a-f0-9]{64}$/.test(report.sha256 || '') ||
    !Array.isArray(report.failures) || !report.failures.every(failure => typeof failure === 'string') ||
    !Array.isArray(report.profiles) || (hash && report.sha256 !== hash)) {
    throw new Error('Playback report is invalid or does not match the built artifact')
  }
  requireFresh(report.generatedAt, Math.max(since, Date.parse(health.generatedAt)), now, 'Playback report')
  if (!isDeepStrictEqual(report.policy, playbackPolicy(config)) ||
    !isDeepStrictEqual(normalizeProbes(report.probes), normalizeProbes(health.probes))) {
    throw new Error('Playback and health policies or probes differ')
  }
  const sources = report.profiles[0]?.sources
  if (report.profiles[0]?.profile !== 'bytes' || !sources || !Object.keys(sources).length ||
    Object.entries(sources).some(([platform, qualities]) => !PLATFORMS.includes(platform) ||
      !Array.isArray(qualities) || !qualities.length || new Set(qualities).size !== qualities.length ||
      qualities.some(quality => !QUALITIES.includes(quality)))) {
    throw new Error('Playback report has invalid platform or quality declarations')
  }
  const head = Object.fromEntries(Object.entries(sources).map(([platform, qualities]) =>
    [platform, qualities.filter(quality => quality !== 'flac' && quality !== 'flac24bit')]).filter(([, qualities]) => qualities.length))
  const expected = { bytes: sources, ...(Object.keys(head).length ? { head } : {}) }
  if (!isDeepStrictEqual(report.profiles.map(profile => profile.profile), Object.keys(expected))) {
    throw new Error('Playback report is missing a required host profile')
  }
  let failed = 0
  for (const profile of report.profiles) {
    if (profile.error || !isDeepStrictEqual(profile.sources, expected[profile.profile]) || !Array.isArray(profile.results)) {
      throw new Error('Playback report contains an initialization error or invalid host declarations')
    }
    const keys = new Set(Object.entries(profile.sources).flatMap(([platform, qualities]) => qualities.flatMap(quality =>
      health.probes[platform].map(probe => JSON.stringify([platform, quality, probe.id])))))
    if (profile.results.length !== keys.size) throw new Error('Playback report has an incomplete probe matrix')
    for (const result of profile.results) {
      if (!result || result.source !== `merged:${profile.profile}` || result.sha256 !== report.sha256 ||
        !keys.delete(JSON.stringify([result.platform, result.quality, result.probeId])) ||
        ['l1', 'l2', 'l3'].some(key => typeof result[key] !== 'boolean') ||
        (result.l2 && !result.l1) || (result.l3 && !result.l2) ||
        (result.skipped !== undefined && typeof result.skipped !== 'boolean') ||
        (result.skipped && (result.l1 || result.l2 || result.l3))) {
        throw new Error('Playback report has invalid or duplicate probe results')
      }
    }
    for (const [platform, qualities] of Object.entries(profile.sources)) for (const quality of qualities) {
      if (!profile.results.some(result => result.platform === platform && result.quality === quality && result.l3)) failed++
    }
  }
  if (report.ok !== (failed === 0) || report.failures.length !== failed) {
    throw new Error('Playback report outcome does not match its probe results')
  }
}

const cell = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
export function dailyMarkdown(report) {
  const status = { ready: '本轮验收通过，可以发布新脚本。',
    retained: report.previous ? '本轮未更新，保留原脚本并跳过发布。' : '本轮未更新，当前没有可保留的原脚本；跳过发布。',
    error: '任务失败，本轮结果不满足发布条件。' }
  const stages = { passed: '通过', unavailable: '上游不可用', error: '错误', skipped: '未执行' }
  return [
    `# 每日音源任务 ${report.startedAt}`, '', status[report.status], '',
    ...(report.reason ? [`原因：${cell(report.reason)}`, ''] : []),
    `开始：${report.startedAt}；结束：${report.finishedAt}。`, '',
    '| 步骤 | 执行次数 / 上限 | 结果 |', '|---|---|---|',
    ...report.stages.map(stage => `| ${stage.label} | ${stage.attempts.length}/${stage.maxAttempts} | ${stages[stage.status]} |`), '',
    ...report.stages.flatMap(stage => stage.attempts.filter(attempt => attempt.exitCode !== 0).map(attempt =>
      `- ${stage.label}第 ${attempt.attempt} 次：${cell(attempt.detail || `退出码 ${attempt.exitCode}，信号 ${attempt.signal || '-'}`)}`)), '',
    `原脚本生成时间：${report.previous?.generatedAt || '未知或不存在'}。`,
    `原脚本 SHA256：${report.previous ? `\`${report.previous.sha256}\`` : '不存在'}。`, '',
    ...(report.status === 'ready' ? [`候选脚本生成时间：${report.artifact.generatedAt}。`,
      `候选脚本 SHA256：\`${report.artifact.sha256}\`。`, ''] : []),
    ...(report.playback?.failures.length ? ['## 本轮播放验收失败', '',
      ...report.playback.failures.map(failure => `- ${cell(failure)}`), ''] : []),
    '本轮未更新不代表旧脚本已重新验证；客户端请同时查看已发布报告的时间。', '',
    '只有明确的上游不可用会重试或跳过更新。配置、沙箱、源码校验和程序错误仍使任务失败。', '',
  ].join('\n')
}

export async function runDaily({ cwd = process.cwd(), env = process.env, runner = runStage, wait = delay, now = Date.now } = {}) {
  cwd = path.resolve(cwd)
  const file = relative => path.join(cwd, relative)
  const report = { schemaVersion: 1, startedAt: new Date(now()).toISOString(), status: 'running', previous: null,
    stages: STAGES.map(stage => ({ name: stage.name, label: stage.label, maxAttempts: stage.retries.length + 1,
      status: 'skipped', attempts: [] })) }
  let failure, current, state, health
  try {
    report.previous = await artifactInfo(file('dist/merged-source.js'))
    // These ignored JSON files describe this invocation only; published Markdown stays intact.
    for (const name of ['health', 'playback']) await fs.rm(file(`reports/${name}.json`), { force: true })
    const previousState = await readJson(file('state.json'), null)
    const config = await readJson(file('config.json'))
    if ((config.mode || 'embed') !== 'embed') throw new Error('Only embed mode is supported')
    normalizeProbes(config.health?.probes)
    stages: for (const spec of STAGES) {
      current = report.stages.find(stage => stage.name === spec.name)
      for (let index = 0; index < current.maxAttempts; index++) {
        const attempt = { attempt: index + 1, startedAt: new Date(now()).toISOString() }
        current.attempts.push(attempt)
        const childEnv = { ...env }
        if (spec.name !== 'fetch') { delete childEnv.GITHUB_TOKEN; delete childEnv.GH_TOKEN }
        console.log(`Daily ${spec.name}: attempt ${attempt.attempt}/${current.maxAttempts}`)
        let result
        try { result = await runner(spec.name, { cwd, env: childEnv, attempt: attempt.attempt }) }
        catch (error) {
          attempt.finishedAt = new Date(now()).toISOString()
          attempt.detail = safeDetail(error.message || error)
          throw error
        }
        attempt.finishedAt = new Date(now()).toISOString()
        attempt.exitCode = result?.code ?? null
        attempt.signal = result?.signal || null
        attempt.detail = safeDetail(result?.detail || '')
        if (attempt.signal || (attempt.exitCode !== 0 && attempt.exitCode !== UNAVAILABLE_EXIT_CODE)) {
          throw new Error(`${spec.name} failed: ${attempt.detail || `exit ${attempt.exitCode}, signal ${attempt.signal || '-'}`}`)
        }
        const since = Date.parse(attempt.startedAt)
        if (spec.name === 'fetch' && attempt.exitCode === 0) {
          state = await readJson(file('state.json'))
          if (state?.schemaVersion !== 2 || !state.runId || state.runId === previousState?.runId || !Object.keys(state.sources || {}).length) {
            throw new Error('Fetch did not produce a new immutable source snapshot')
          }
          requireFresh(state.lastRun, since, now(), 'Source snapshot')
          report.runId = state.runId
        }
        if (spec.name === 'health') {
          health = await readJson(file('reports/health.json'))
          validateReport(state, health, { now: now(), policy: playbackPolicy(config),
            maxAgeMs: boundedNumber(config.embed?.maxReportAgeMs, 86400000, 1, 86400000) })
          requireFresh(health.generatedAt, since, now(), 'Health report')
          if (health.results.some(result => result.l3) !== (attempt.exitCode === 0)) {
            throw new Error('Health exit code does not match its probe results')
          }
        }
        if (spec.name === 'build') {
          const playback = await readJson(file('reports/playback.json'))
          const artifact = await artifactInfo(file('dist/merged-source.js'))
          checkPlayback(playback, health, config, { since, now: now(), ok: attempt.exitCode === 0,
            hash: attempt.exitCode === 0 ? artifact?.sha256 : undefined })
          report.playback = { generatedAt: playback.generatedAt, sha256: playback.sha256, ok: playback.ok,
            failures: playback.failures.map(safeDetail) }
          if (attempt.exitCode === 0) {
            if (!artifact) throw new Error('Build did not produce an artifact')
            requireFresh(artifact.generatedAt, since, now(), 'Built artifact')
            if (!isDeepStrictEqual(state, await readJson(file('state.json'))) ||
              !isDeepStrictEqual(health, await readJson(file('reports/health.json')))) {
              throw new Error('Source state or health report changed during the build')
            }
            report.artifact = artifact
          }
        }
        if (attempt.exitCode === 0) { current.status = 'passed'; break }
        if (!isDeepStrictEqual(report.previous, await artifactInfo(file('dist/merged-source.js')))) {
          throw new Error('An unavailable stage changed the previous artifact')
        }
        current.status = 'unavailable'
        if (index < spec.retries.length) {
          console.log(`Daily ${spec.name}: upstream unavailable; retrying in ${spec.retries[index]}ms`)
          await wait(spec.retries[index])
        } else {
          report.status = 'retained'
          report.reason = `${spec.label}不可用，已用完本轮尝试次数。${attempt.detail}`
          break stages
        }
      }
    }
    if (report.status === 'running') report.status = 'ready'
  } catch (error) {
    failure = error
    if (current) current.status = 'error'
    report.status = 'error'
    report.reason = safeDetail(error.message || error)
  }
  report.finishedAt = new Date(now()).toISOString()
  const markdown = dailyMarkdown(report)
  await atomicWrite(file('reports/daily.json'), JSON.stringify(report, null, 2) + '\n')
  await atomicWrite(file('reports/daily.md'), markdown)
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, markdown)
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, `ready=${report.status === 'ready'}\n`)
  if (report.status === 'retained') console.log('::notice::本轮未更新，已跳过发布；详情见每日任务报告。')
  else console.log(`Daily result: ${report.status}`)
  if (failure) throw failure
  return report
}

if (isMain(import.meta.url)) {
  try { await runDaily() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
