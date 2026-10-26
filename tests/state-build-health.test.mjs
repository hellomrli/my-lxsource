import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { PLATFORMS, QUALITIES, sha256, cacheScript, readSnapshot, normalizeSources } from '../scripts/source-state.mjs'
import { runFetch, diffState } from '../scripts/fetch-upstream.mjs'
import { buildSource, validateReport, renderSource } from '../scripts/build-source.mjs'
import { PROBES, testOne, runHealth, healthMarkdown } from '../scripts/test-sources.mjs'
import { ROOT, tempDir, sourceCode } from './helpers.mjs'

function healthResults(source, hash, healthy = [['wy', '320k']]) {
  return PLATFORMS.flatMap(platform => QUALITIES.map(quality => {
    const ok = healthy.some(([p, q]) => p === platform && q === quality)
    return { source, sha256: hash, platform, quality, l1: ok, l2: ok, l3: ok, skipped: !ok }
  }))
}

async function buildFixture(t, code = sourceCode("return 'https://example.test/good.mp3';")) {
  const dir = await tempDir(t), cacheDir = path.join(dir, 'cache')
  const hash = await cacheScript(code, cacheDir)
  const runId = 'fixture-run', now = Date.now()
  const entry = { sha256: hash, commit: 'a'.repeat(40), url: `https://example.test/${'a'.repeat(40)}/source.js` }
  const state = { schemaVersion: 2, runId, lastRun: new Date(now - 1000).toISOString(), sources: { fixture: entry } }
  const report = { schemaVersion: 2, runId, generatedAt: new Date(now).toISOString(), sourceHashes: { fixture: hash },
    results: healthResults('fixture', hash) }
  const statePath = path.join(dir, 'state.json'), reportPath = path.join(dir, 'health.json')
  const outputPath = path.join(dir, 'merged.js')
  await fs.writeFile(statePath, JSON.stringify(state))
  await fs.writeFile(reportPath, JSON.stringify(report))
  return { dir, cacheDir, state, report, statePath, reportPath, outputPath, now,
    templatePath: path.join(ROOT, 'templates/merged-source.js'), config: { embed: { initTimeoutMs: 500, probeTimeoutMs: 1000 } } }
}

async function addBuildSource(f, id, code, healthy) {
  const hash = await cacheScript(code, f.cacheDir)
  f.state.sources[id] = { ...f.state.sources.fixture, sha256: hash }
  f.report.sourceHashes[id] = hash
  f.report.results.push(...healthResults(id, hash, healthy))
  await fs.writeFile(f.statePath, JSON.stringify(f.state))
  await fs.writeFile(f.reportPath, JSON.stringify(f.report))
}

test('fetch pins source downloads to each repository commit and stores content-addressed snapshots', async t => {
  const dir = await tempDir(t), commit = 'a'.repeat(40), calls = []
  const state = await runFetch({ statePath: path.join(dir, 'state.json'), cacheDir: path.join(dir, 'cache'),
    upstreams: { mock: { repo: 'owner/repo', branch: 'main' } },
    download: async url => {
      calls.push(url)
      if (url.includes('/commits/')) return JSON.stringify({ sha: commit, commit: { committer: { date: '2026-10-21' } } })
      if (url.includes('/git/trees/')) return JSON.stringify({ tree: [{ type: 'blob', path: '中文/latest.js' }] })
      return sourceCode("return 'https://example.test/audio.mp3';")
    },
  })
  const entry = state.sources['mock:中文/latest.js']
  assert.equal(entry.commit, commit)
  assert.match(entry.url, new RegExp('/' + commit + '/'))
  assert.ok(entry.url.includes('%E4%B8%AD%E6%96%87'))
  assert.ok(calls.every(url => !url.includes('/main/') || url.includes('/commits/')))
  assert.equal(sha256(await fs.readFile(path.join(dir, 'cache', `${entry.sha256}.js`))), entry.sha256)
  assert.deepEqual(diffState(state, state).unchanged, ['mock:中文/latest.js'])
})

test('partial upstream failure preserves previous state instead of reporting removals', async t => {
  const dir = await tempDir(t), statePath = path.join(dir, 'state.json')
  const previous = '{"sources":{"keep":{"sha256":"old"}}}\n'
  await fs.writeFile(statePath, previous)
  await assert.rejects(runFetch({ statePath, upstreams: { mock: { repo: 'owner/repo', branch: 'main' } },
    download: async () => { throw new Error('HTTP 503') } }), /previous state preserved/)
  assert.equal(await fs.readFile(statePath, 'utf8'), previous)
})

test('snapshot hash mismatches fail closed; mutable branch URLs are never used', async t => {
  const dir = await tempDir(t), commit = 'a'.repeat(40), code = 'expected'
  const entry = { sha256: sha256(code), commit, url: `https://example.test/${commit}/source.js` }
  await assert.rejects(readSnapshot(entry, { cacheDir: dir, download: async () => 'changed' }), /SHA256 mismatch/)
  await assert.rejects(readSnapshot({ sha256: sha256(code), url: 'https://example.test/main/source.js' },
    { cacheDir: dir, download: async () => { throw new Error('must not download') } }), /not pinned/)
})

test('stale reports, changed run IDs, and source hashes are rejected', async t => {
  const f = await buildFixture(t)
  validateReport(f.state, f.report, { now: f.now })
  assert.throws(() => validateReport(f.state, { ...f.report, runId: 'different' }), /does not match/)
  assert.throws(() => validateReport(f.state, { ...f.report, generatedAt: '2020-01-01' }), /stale/)
  assert.throws(() => validateReport(f.state, { ...f.report, sourceHashes: { fixture: 'b'.repeat(64) } }), /hashes changed/)
  assert.throws(() => validateReport(f.state, { ...f.report,
    results: f.report.results.map(r => r.l3 ? { ...r, l2: false } : r) }), /Inconsistent/)
})

test('incomplete and duplicate health matrices are rejected', async t => {
  const f = await buildFixture(t)
  assert.throws(() => validateReport(f.state, { ...f.report, results: f.report.results.slice(1) }), /incomplete/i)
  const duplicate = [...f.report.results]
  duplicate[1] = { ...duplicate[0] }
  assert.throws(() => validateReport(f.state, { ...f.report, results: duplicate }), /duplicate/i)
})

test('health flags must be booleans and follow L1 to L3 without skipped successes', async t => {
  const f = await buildFixture(t)
  for (const field of ['l1', 'l2', 'l3']) {
    for (const value of ['false', 1, null]) {
      assert.throws(() => validateReport(f.state, { ...f.report,
        results: f.report.results.map(r => r.l3 ? { ...r, [field]: value } : r) }), /boolean/i)
    }
  }
  for (const flags of [{ l1: false, l2: true, l3: false }, { skipped: true }]) {
    assert.throws(() => validateReport(f.state, { ...f.report,
      results: f.report.results.map(r => r.l3 ? { ...r, ...flags } : r) }), /Inconsistent/)
  }
})

test('clean build uses exactly the tested snapshot and validates the merged artifact', async t => {
  const f = await buildFixture(t)
  const result = await buildSource(f)
  assert.deepEqual(Object.keys(result.sources), ['wy'])
  assert.deepEqual(result.sources.wy.qualitys, ['320k'])
  assert.equal(result.subs[0].sha256, f.state.sources.fixture.sha256)
  new vm.Script(await fs.readFile(f.outputPath, 'utf8'))
})

test('build-time script failure is not embedded and does not overwrite the last good artifact', async t => {
  const f = await buildFixture(t, "throw new Error('broken source')")
  await fs.writeFile(f.outputPath, 'previous good artifact')
  await assert.rejects(buildSource(f), /All candidate sources failed/)
  assert.equal(await fs.readFile(f.outputPath, 'utf8'), 'previous good artifact')
})

test('identical scripts are embedded once while preserving healthy coverage from every alias', async t => {
  const f = await buildFixture(t)
  const code = await readSnapshot(f.state.sources.fixture, { cacheDir: f.cacheDir })
  await addBuildSource(f, 'alias', code, [['mg', '320k']])
  const loaded = { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
    mg: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } }
  let sourceLoads = 0
  const result = await buildSource({ ...f, load: async script => {
    if (script === code) sourceLoads++
    return { error: null, sources: loaded, dispose() {} }
  } })
  assert.equal(result.subs.length, 1)
  assert.deepEqual(Object.keys(result.sources), ['wy', 'mg'])
  assert.equal(sourceLoads, 1)
})

test('duplicate scripts do not consume maxSources slots', async t => {
  const f = await buildFixture(t)
  const code = await readSnapshot(f.state.sources.fixture, { cacheDir: f.cacheDir })
  await addBuildSource(f, 'alias', code)
  await addBuildSource(f, 'z-good', sourceCode("return 'https://example.test/other.mp3';"))
  f.config.embed.maxSources = 2
  const result = await buildSource(f)
  assert.equal(result.subs.length, 2)
  assert.equal(new Set(result.subs.map(s => s.sha256)).size, 2)
})

test('embedded byte budgets skip oversized sources without blocking smaller ones', async t => {
  const big = sourceCode("return 'https://example.test/big.mp3';") + '\n//' + 'x'.repeat(4096)
  const f = await buildFixture(t, big)
  await addBuildSource(f, 'z-small', sourceCode("return 'https://example.test/small.mp3';"))
  f.config.embed.maxSourceBytes = 2048
  const single = await buildSource(f)
  assert.deepEqual(single.subs.map(s => s.key), ['z-small'])
  f.config.embed.maxSourceBytes = 0
  f.config.embed.maxEmbedBytes = Buffer.byteLength(big)
  const total = await buildSource(f)
  assert.deepEqual(total.subs.map(s => s.key), ['fixture'])
})

const brandedSource = (name, version, body = "return 'https://example.test/audio.mp3';") =>
  `/*!\n * @name ${name}\n * @version ${version}\n */\n` + sourceCode(body)

test('only the newest usable version of the same brand is embedded', async t => {
  const f = await buildFixture(t, brandedSource('星海音乐源', '3.2.12'))
  await addBuildSource(f, 'z-new', brandedSource('星海音乐源', '3.2.15'))
  const result = await buildSource(f)
  assert.deepEqual(result.subs.map(s => s.key), ['z-new'])
})

test('a newest version that fails to initialize falls back to an older usable one', async t => {
  const f = await buildFixture(t, brandedSource('某某音源', '1.0.0'))
  await addBuildSource(f, 'z-new', `/*!\n * @name 某某音源\n * @version 2.0.0\n */\nthrow new Error('broken init')`)
  const result = await buildSource(f)
  assert.deepEqual(result.subs.map(s => s.key), ['fixture'])
})

test('a failed candidate cannot prevent a lower-ranked valid source from filling maxSources', async t => {
  const f = await buildFixture(t, "throw new Error('broken preferred source')")
  await addBuildSource(f, 'z-good', sourceCode("return 'https://example.test/good.mp3';"))
  f.config.embed.maxSources = 1
  const result = await buildSource(f)
  assert.equal(result.subs.length, 1)
  assert.equal(result.subs[0].key, 'z-good')
})

test('build excludes dynamic-code-only sources and validates the output with code generation disabled', async t => {
  const f = await buildFixture(t, "eval('globalThis');" + sourceCode("return 'https://example.test/dynamic.mp3';"))
  await addBuildSource(f, 'z-static', sourceCode("return 'https://example.test/good.mp3';"))
  const result = await buildSource(f)
  assert.deepEqual(result.subs.map(s => s.key), ['z-static'])
})

test('candidate and merged validation both request a code-generation-disabled runtime', async t => {
  const f = await buildFixture(t), options = []
  await buildSource({ ...f, load: async (script, config) => {
    options.push(config)
    return { error: null, sources: { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] } }, dispose() {} }
  } })
  assert.equal(options.length, 2)
  assert.ok(options.every(option => option.allowCodeGeneration === false))
})

test('unknown platforms and invalid quality declarations do not reach LX clients', () => {
  const sources = normalizeSources({ qs: { type: 'music', actions: ['musicUrl'], qualitys: ['flac'] },
    wy: { type: 'music', actions: ['musicUrl', 'search'], qualitys: ['192k', '320k'] } })
  assert.deepEqual(Object.keys(sources), ['wy'])
  assert.deepEqual(sources.wy.qualitys, ['320k'])
})

test('rendered comment metadata cannot terminate the script header', async t => {
  const f = await buildFixture(t)
  const tpl = await fs.readFile(f.templatePath, 'utf8')
  const result = renderSource(tpl, [{ key: 'test', name: 'test */\n throw 1', healthy: { wy: ['320k'] }, code: sourceCode("return 'x'") }],
    { name: 'injected */\n throw 1' })
  new vm.Script(result)
  assert.ok(result.includes('injected * /  throw 1'))
})

test('probes include native Kugou hash and separate Migu song/copyright IDs', () => {
  assert.equal(PROBES.kg.musicInfo.hash, PROBES.kg.musicInfo.songmid)
  assert.equal(PROBES.mg.musicInfo.songmid, '3790007')
  assert.equal(PROBES.mg.musicInfo.copyrightId, '60054701923')
})

test('health uses verified HTTP status rather than the presence of any response', async () => {
  const rt = { sources: { wy: { qualitys: ['320k'] } }, callMusicUrl: async () => 'https://example.test/missing.mp3' }
  const result = await testOne(rt, { id: 'test', sha256: 'a'.repeat(64) }, 'wy', '320k', PROBES.wy,
    async () => ({ ok: false, connected: false, status: 404 }))
  assert.equal(result.l1, true)
  assert.equal(result.l2, false)
  assert.equal(result.l3, false)
})

test('health error details redact signed URLs', async () => {
  const rt = { sources: { wy: { qualitys: ['320k'] } }, callMusicUrl: async () => {
    throw new Error('failed https://example.test/audio?token=secret')
  } }
  const result = await testOne(rt, { id: 'test', sha256: 'a'.repeat(64) }, 'wy', '320k', PROBES.wy)
  assert.equal(result.detail.includes('secret'), false)
  assert.match(result.detail, /URL redacted/)
})

test('health reports cover all five platforms and all four qualities without publishing temporary playback URLs', async t => {
  const f = await buildFixture(t)
  const declared = Object.fromEntries(['wy', 'tx', 'kw', 'kg', 'mg'].map(p => [p,
    { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac', 'flac24bit'] }]))
  const report = await runHealth({ statePath: f.statePath, reportPath: f.reportPath,
    markdownPath: path.join(f.dir, 'health.md'), cacheDir: f.cacheDir, config: {},
    load: async (script, options) => {
      assert.equal(options.allowCodeGeneration, false)
      return { error: null, sources: declared, dispose() {},
        callMusicUrl: async (platform, info, quality) => {
          if (platform === 'kg') assert.equal(info.hash, PROBES.kg.musicInfo.hash)
          if (platform === 'mg') assert.equal(info.copyrightId, PROBES.mg.musicInfo.copyrightId)
          return `https://example.test/audio?token=private-${quality}`
        } }
    },
    verify: async () => ({ ok: true, connected: true, status: 206, magic: 'flac', bytes: 4096 }),
  })
  assert.equal(report.results.length, 20)
  assert.equal(report.summary[0].l3Count, 5)
  assert.equal(report.runId, f.state.runId)
  assert.equal(JSON.stringify(report).includes('token=private'), false)
  assert.equal(healthMarkdown(report).includes('| mg |'), true)
})

test('health does not count playback handlers that only work with dynamic code execution', async t => {
  const f = await buildFixture(t, sourceCode("return eval(\"'https://example.test/dynamic.mp3'\");"))
  await assert.rejects(runHealth({ statePath: f.statePath, reportPath: f.reportPath,
    markdownPath: path.join(f.dir, 'health.md'), cacheDir: f.cacheDir, config: {},
    verify: async () => { throw new Error('A blocked handler must not reach audio verification') },
  }), /No healthy sources/)
  const report = JSON.parse(await fs.readFile(f.reportPath, 'utf8'))
  const result = report.results.find(r => r.platform === 'wy' && r.quality === '320k')
  assert.equal(result.l1, false)
  assert.equal(result.l3, false)
  assert.match(result.detail, /Code generation from strings disallowed/)
})
