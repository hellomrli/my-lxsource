import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runDaily } from '../scripts/run-daily.mjs'
import { runFetch } from '../scripts/fetch-upstream.mjs'
import { runHealth } from '../scripts/test-sources.mjs'
import { buildSource } from '../scripts/build-source.mjs'
import { AvailabilityError, UNAVAILABLE_EXIT_CODE } from '../scripts/availability.mjs'
import { sha256 } from '../scripts/source-state.mjs'
import { ROOT, tempDir, sourceCode } from './helpers.mjs'

const declared = { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } }
const load = async () => ({ error: null, sources: declared, dispose() {},
  callMusicUrl: async () => 'https://example.test/audio.mp3' })
const good = async () => ({ ok: true, connected: true, status: 206, magic: 'mp3(ID3)', bytes: 4096 })
const unavailable = async () => ({ ok: false, connected: false, status: 503 })
const oldArtifact = '/*\n * Generated at: 2026-11-14T00:00:00.000Z\n */\nprevious good artifact\n'
const upstreams = { fixture: { repo: 'owner/repo', branch: 'main' } }
const download = async url => {
  if (url.includes('/commits/')) return JSON.stringify({ sha: 'a'.repeat(40) })
  if (url.includes('/git/trees/')) return JSON.stringify({ tree: [{ type: 'blob', path: 'latest.js' }] })
  return sourceCode("return 'https://example.test/audio.mp3';")
}

async function fixture(t) {
  const cwd = await tempDir(t)
  const config = { mode: 'embed', embed: { initTimeoutMs: 60, probeTimeoutMs: 60 } }
  await fs.mkdir(path.join(cwd, 'dist'))
  await fs.mkdir(path.join(cwd, 'reports'))
  await fs.writeFile(path.join(cwd, 'config.json'), JSON.stringify(config))
  await fs.writeFile(path.join(cwd, 'dist/merged-source.js'), oldArtifact)
  await fs.writeFile(path.join(cwd, 'reports/health.md'), 'previous published health')
  await fs.writeFile(path.join(cwd, 'reports/playback.md'), 'previous published playback')
  const env = { PATH: process.env.PATH, GITHUB_OUTPUT: path.join(cwd, 'output'),
    GITHUB_STEP_SUMMARY: path.join(cwd, 'summary') }
  const calls = [], waits = []
  const invoke = async (stage, { verify = good } = {}) => {
    const options = { statePath: path.join(cwd, 'state.json'), cacheDir: path.join(cwd, '.cache/sources'), config, load, verify }
    try {
      if (stage === 'fetch') await runFetch({ ...options, upstreams, download, githubToken: '' })
      if (stage === 'health') await runHealth({ ...options, reportPath: path.join(cwd, 'reports/health.json'),
        markdownPath: path.join(cwd, 'reports/health.md') })
      if (stage === 'build') await buildSource({ ...options, reportPath: path.join(cwd, 'reports/health.json'),
        outputPath: path.join(cwd, 'dist/merged-source.js'), templatePath: path.join(ROOT, 'templates/merged-source.js') })
      return { code: 0 }
    } catch (error) {
      return { code: error instanceof AvailabilityError ? UNAVAILABLE_EXIT_CODE : 1, detail: error.message }
    }
  }
  const runner = async (stage, options) => { calls.push({ stage, ...options }); return invoke(stage) }
  return { cwd, env, invoke, calls, waits, options: { cwd, env, runner, wait: async ms => { waits.push(ms) } },
    read: async relative => JSON.parse(await fs.readFile(path.join(cwd, relative), 'utf8')) }
}

test('exhausted upstream fetches retain the old artifact, skip later stages, and write truthful diagnostics', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.cwd, 'reports/health.json'), '{"old":true}')
  await fs.writeFile(path.join(f.cwd, 'reports/playback.json'), '{"old":true}')
  const report = await runDaily({ ...f.options, runner: async (stage, options) => {
    f.calls.push({ stage, ...options })
    return { code: 2, detail: 'Download HTTP 503 https://example.test/?token=private' }
  } })
  assert.equal(report.status, 'retained')
  assert.deepEqual(f.calls.map(call => call.stage), ['fetch', 'fetch', 'fetch'])
  assert.deepEqual(f.waits, [2000, 5000])
  assert.deepEqual(report.stages.map(stage => stage.status), ['unavailable', 'skipped', 'skipped'])
  assert.equal(report.previous.sha256, sha256(oldArtifact))
  assert.equal(await fs.readFile(path.join(f.cwd, 'dist/merged-source.js'), 'utf8'), oldArtifact)
  assert.equal(await fs.readFile(path.join(f.cwd, 'reports/playback.md'), 'utf8'), 'previous published playback')
  assert.equal(await fs.readFile(path.join(f.cwd, 'reports/health.md'), 'utf8'), 'previous published health')
  await assert.rejects(fs.access(path.join(f.cwd, 'reports/health.json')), { code: 'ENOENT' })
  await assert.rejects(fs.access(path.join(f.cwd, 'reports/playback.json')), { code: 'ENOENT' })
  const saved = await f.read('reports/daily.json')
  assert.equal(saved.status, 'retained')
  assert.ok(!JSON.stringify(saved).includes('token=private'))
  assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'ready=false\n')
  const summary = await fs.readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8')
  assert.match(summary, /本轮未更新/)
  assert.match(summary, /2026-11-14T00:00:00/)
  assert.match(summary, /不代表旧脚本已重新验证/)
})

test('fetch and playback retries can recover and only a fresh matching artifact opens the publication gate', async t => {
  const f = await fixture(t)
  const report = await runDaily({ ...f.options, runner: async (stage, options) => {
    f.calls.push({ stage, ...options })
    if (stage === 'fetch' && options.attempt === 1) return { code: 2, detail: 'Download HTTP 503' }
    return f.invoke(stage, { verify: stage === 'build' && options.attempt === 1 ? unavailable : good })
  } })
  assert.equal(report.status, 'ready')
  assert.deepEqual(f.calls.map(call => call.stage), ['fetch', 'fetch', 'health', 'build', 'build'])
  assert.deepEqual(f.waits, [2000, 5000])
  assert.deepEqual(report.stages.map(stage => stage.status), ['passed', 'passed', 'passed'])
  const artifact = await fs.readFile(path.join(f.cwd, 'dist/merged-source.js'))
  assert.equal(report.artifact.sha256, sha256(artifact))
  assert.notEqual(report.artifact.sha256, report.previous.sha256)
  assert.equal((await f.read('reports/playback.json')).ok, true)
  assert.equal(report.playback.sha256, report.artifact.sha256)
  assert.equal(report.runId, (await f.read('state.json')).runId)
  assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'ready=true\n')
})

test('a failed playback retry retains the script and reports both host failures', async t => {
  const f = await fixture(t)
  const report = await runDaily({ ...f.options, runner: async (stage, options) => {
    f.calls.push({ stage, ...options })
    return f.invoke(stage, { verify: stage === 'build' ? unavailable : good })
  } })
  assert.equal(report.status, 'retained')
  assert.deepEqual(f.calls.map(call => call.stage), ['fetch', 'health', 'build', 'build'])
  assert.deepEqual(f.waits, [5000])
  assert.equal(await fs.readFile(path.join(f.cwd, 'dist/merged-source.js'), 'utf8'), oldArtifact)
  const playback = await f.read('reports/playback.json')
  assert.equal(playback.ok, false)
  assert.equal(playback.failures.length, 2)
  assert.deepEqual(playback.profiles.map(profile => profile.profile), ['bytes', 'head'])
  const summary = await fs.readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8')
  assert.match(summary, /Merged playback validation failed \(bytes wy\/320k\)/)
  assert.match(summary, /Merged playback validation failed \(head wy\/320k\)/)
  assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'ready=false\n')
})

test('zero healthy sources do not repeat the expensive health scan or attempt a build', async t => {
  const f = await fixture(t)
  const report = await runDaily({ ...f.options, runner: async (stage, options) => {
    f.calls.push({ stage, ...options })
    return f.invoke(stage, { verify: stage === 'health' ? unavailable : good })
  } })
  assert.equal(report.status, 'retained')
  assert.deepEqual(f.calls.map(call => call.stage), ['fetch', 'health'])
  assert.deepEqual(f.waits, [])
  assert.ok((await f.read('reports/health.json')).results.every(result => !result.l3))
  assert.equal(report.stages[2].status, 'skipped')
})

test('an outage with no previous artifact explicitly reports that there is nothing to retain', async t => {
  const f = await fixture(t)
  await fs.rm(path.join(f.cwd, 'dist/merged-source.js'))
  const report = await runDaily({ ...f.options, runner: async () => ({ code: 2, detail: 'HTTP 429' }) })
  assert.equal(report.status, 'retained')
  assert.equal(report.previous, null)
  assert.match(await fs.readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /没有可保留的原脚本/)
})

test('unexpected exits and spawn failures stay fatal, save an error report, and never retry', async t => {
  for (const result of [{ code: 1, detail: 'Invalid commit' }, { code: 3 }, { code: null, signal: 'SIGTERM' },
    { code: '0' }, new Error('spawn ENOENT')]) {
    const f = await fixture(t)
    await assert.rejects(runDaily({ ...f.options, runner: async (stage, options) => {
      f.calls.push({ stage, ...options })
      if (result instanceof Error) throw result
      return result
    } }))
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.waits, [])
    assert.equal((await f.read('reports/daily.json')).status, 'error')
    assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'ready=false\n')
  }
})

test('stale snapshots and health reports stay fatal even when a stage exits successfully', async t => {
  for (const target of ['fetch', 'health']) {
    const f = await fixture(t)
    await assert.rejects(runDaily({ ...f.options, runner: async (stage, options) => {
      f.calls.push({ stage, ...options })
      const result = await f.invoke(stage)
      if (stage === target) {
        const relative = stage === 'fetch' ? 'state.json' : 'reports/health.json'
        const data = await f.read(relative)
        data[stage === 'fetch' ? 'lastRun' : 'generatedAt'] = '2020-01-01T00:00:00.000Z'
        await fs.writeFile(path.join(f.cwd, relative), JSON.stringify(data))
      }
      return result
    } }), /stale/)
    assert.equal(f.calls.at(-1).stage, target)
    assert.equal((await f.read('reports/daily.json')).status, 'error')
  }
})

test('artifact mismatch and incomplete or inconsistent playback reports cannot authorize publication', async t => {
  const corruptions = [
    report => { report.sha256 = 'b'.repeat(64) },
    report => { report.generatedAt = '2020-01-01T00:00:00.000Z' },
    report => { report.profiles.pop() },
    report => { report.profiles[0].results.pop() },
    report => { report.profiles[0].results[1] = report.profiles[0].results[0] },
    report => { report.profiles[0].results[0].l3 = 'true' },
    report => { report.failures.push('unacknowledged failure') },
  ]
  for (const corrupt of corruptions) {
    const f = await fixture(t)
    await assert.rejects(runDaily({ ...f.options, runner: async (stage, options) => {
      f.calls.push({ stage, ...options })
      const result = await f.invoke(stage)
      if (stage === 'build') {
        const playback = await f.read('reports/playback.json')
        corrupt(playback)
        await fs.writeFile(path.join(f.cwd, 'reports/playback.json'), JSON.stringify(playback))
      }
      return result
    } }))
    assert.equal(f.calls.filter(call => call.stage === 'build').length, 1)
    assert.deepEqual(f.waits, [])
    assert.equal((await f.read('reports/daily.json')).status, 'error')
    assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'ready=false\n')
  }
})

test('an unavailable build with invalid diagnostics or a replaced old artifact stays fatal', async t => {
  for (const corruption of ['report', 'artifact']) {
    const f = await fixture(t)
    await assert.rejects(runDaily({ ...f.options, runner: async (stage, options) => {
      f.calls.push({ stage, ...options })
      const result = await f.invoke(stage, { verify: stage === 'build' ? unavailable : good })
      if (stage === 'build') {
        if (corruption === 'report') await fs.rm(path.join(f.cwd, 'reports/playback.json'))
        else await fs.writeFile(path.join(f.cwd, 'dist/merged-source.js'), 'untested replacement')
      }
      return result
    } }))
    assert.equal(f.calls.filter(call => call.stage === 'build').length, 1)
    assert.deepEqual(f.waits, [])
    assert.equal((await f.read('reports/daily.json')).status, 'error')
    assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'ready=false\n')
  }
})

test('invalid configuration is fatal before any upstream work', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.cwd, 'reports/playback.json'), '{"old":true}')
  await fs.writeFile(path.join(f.cwd, 'config.json'), '{broken')
  await assert.rejects(runDaily(f.options), SyntaxError)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.read('reports/daily.json')).status, 'error')
  await assert.rejects(fs.access(path.join(f.cwd, 'reports/playback.json')), { code: 'ENOENT' })
})

test('real stage subprocesses pass GitHub credentials only to fetch', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.cwd, 'scripts'))
  const module = name => JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', name)).href)
  const stub = `const load = ${load.toString()};\nconst declared = ${JSON.stringify(declared)};\nconst verify = ${good.toString()};\n`
  const noTokens = "assert.equal(process.env.GITHUB_TOKEN, undefined); assert.equal(process.env.GH_TOKEN, undefined);\n"
  await fs.writeFile(path.join(f.cwd, 'scripts/fetch-upstream.mjs'), `
    import assert from 'node:assert/strict'
    import { runFetch } from ${module('fetch-upstream.mjs')}
    assert.equal(process.env.GITHUB_TOKEN, 'fixture-api-token')
    assert.equal(process.env.GH_TOKEN, 'fixture-gh-token')
    const sourceCode = ${sourceCode.toString()}
    await runFetch({ upstreams: ${JSON.stringify(upstreams)}, download: ${download.toString()}, githubToken: '' })
  `)
  await fs.writeFile(path.join(f.cwd, 'scripts/test-sources.mjs'), `
    import assert from 'node:assert/strict'
    import { runHealth } from ${module('test-sources.mjs')}
    ${noTokens}${stub}
    await runHealth({ load, verify })
  `)
  await fs.writeFile(path.join(f.cwd, 'scripts/build-source.mjs'), `
    import assert from 'node:assert/strict'
    import { buildSource } from ${module('build-source.mjs')}
    ${noTokens}${stub}
    await buildSource({ load, verify, templatePath: ${JSON.stringify(path.join(ROOT, 'templates/merged-source.js'))} })
  `)
  const env = { ...f.env, GITHUB_TOKEN: 'fixture-api-token', GH_TOKEN: 'fixture-gh-token' }
  const report = await runDaily({ cwd: f.cwd, env, wait: f.options.wait })
  assert.equal(report.status, 'ready')
  assert.equal(env.GITHUB_TOKEN, 'fixture-api-token')
  assert.equal(env.GH_TOKEN, 'fixture-gh-token')
  assert.equal(await fs.readFile(f.env.GITHUB_OUTPUT, 'utf8'), 'ready=true\n')
})
