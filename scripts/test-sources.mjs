/** 三层可用性检测: L1 取URL → L2 连通 → L3 真音频 */
import fs from 'node:fs/promises'
import { loadSource, verifyAudioUrl } from './lx-runtime.mjs'

// 每个平台一个稳定的探针曲目（songmid 长期有效）
const PROBES = {
  wy: { source: 'wy', musicInfo: { songmid: '2652820720', name: '晴天(深情版)', singer: 'Lucky小爱', source: 'wy', interval: '04:38' } },
  tx: { source: 'tx', musicInfo: { songmid: '0039MnYb0qxYhV', name: '晴天', singer: '周杰伦', source: 'tx', interval: '04:29' } },
  kw: { source: 'kw', musicInfo: { songmid: '228908', name: '晴天', singer: '周杰伦', source: 'kw', interval: '04:29' } },
  kg: { source: 'kg', musicInfo: { songmid: 'B3A52A7A958BF0AED0EBFBA2E9A818B7', name: '晴天', singer: '周杰伦', source: 'kg', interval: '04:29' } },
}

const UPSTREAM = 'pdone/lx-music-source'
const QUALITY = '320k'
const CONCURRENCY = 3

/** 按 state.json 里记录的 URL 下载（支持多仓库） */
async function fetchScript(name, sources) {
  const entry = sources?.[name]
  const url = entry?.url || `https://raw.githubusercontent.com/${UPSTREAM}/main/${name}/latest.js`
  const res = await fetch(url, { headers: { 'User-Agent': 'lx-source-guard' } })
  if (!res.ok) throw new Error(`download ${res.status}`)
  return res.text()
}

/** 测试单个音源 × 单个平台 */
async function testOne(name, script, platform) {
  const probe = PROBES[platform]
  const out = { source: name, platform, l1: false, l2: false, l3: false, url: null, detail: '' }
  let rt
  try {
    rt = await loadSource(script)
  } catch (e) { out.detail = `L0 加载失败: ${e.message}`; return out }
  if (rt.error) { out.detail = `L0 ${rt.error}`; return out }
  if (!rt.sources?.[platform]) { out.detail = `不支持该平台`; return out }

  // L1: 能返回非空 URL
  let url = null
  try {
    url = await rt.callMusicUrl(probe.source, probe.musicInfo, QUALITY)
  } catch (e) { out.detail = `L1 失败: ${String(e.message || e).slice(0, 60)}`; return out }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    out.detail = `L1 返回无效: ${String(url).slice(0, 40)}`; return out
  }
  out.l1 = true; out.url = url

  // L2 + L3: 连通且为真音频
  const v = await verifyAudioUrl(url)
  out.l2 = v.ok || v.status > 0
  out.l3 = !!v.ok
  out.detail = v.ok
    ? `OK ${v.status} ${v.magic} ${v.bytes}B`
    : `L2/L3 失败: HTTP ${v.status} ct=${v.contentType || '-'} magic=${v.magic || '-'}${v.error ? ' ' + v.error : ''}`
  return out
}

async function pool(items, limit, fn) {
  const results = []
  const running = new Set()
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item)).then(r => { results.push(r); running.delete(p) })
    running.add(p)
    if (running.size >= limit) await Promise.race(running)
  }
  await Promise.all(running)
  return results
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const state = JSON.parse(await fs.readFile('state.json', 'utf8').catch(() => '{}'))
  const names = Object.keys(state.sources || {})
  if (!names.length) { console.error('state.json 里没有音源，请先跑 npm run fetch'); process.exit(1) }

  console.log(`开始检测 ${names.length} 个音源 × ${Object.keys(PROBES).length} 个平台\n`)

  const scripts = {}
  for (const n of names) {
    try { scripts[n] = await fetchScript(n, state.sources) } catch (e) { console.warn(`  跳过 ${n}: ${e.message}`) }
  }

  const jobs = []
  for (const n of Object.keys(scripts)) for (const p of Object.keys(PROBES)) jobs.push([n, p])

  let done = 0
  const results = await pool(jobs, CONCURRENCY, async ([n, p]) => {
    const r = await testOne(n, scripts[n], p)
    done++
    process.stdout.write(`\r  进度 ${done}/${jobs.length}`)
    return r
  })
  process.stdout.write('\n\n')

  // 汇总
  const bySource = {}
  for (const r of results) {
    bySource[r.source] ??= { source: r.source, platforms: {}, l3Count: 0 }
    bySource[r.source].platforms[r.platform] = r
    if (r.l3) bySource[r.source].l3Count++
  }
  const summary = Object.values(bySource).sort((a, b) => b.l3Count - a.l3Count)

  console.log('音源'.padEnd(40), 'wy tx kw kg', ' 可用')
  for (const s of summary) {
    const marks = ['wy','tx','kw','kg'].map(p => s.platforms[p]?.l3 ? ' ✅' : (s.platforms[p]?.l1 ? ' ⚠' : ' ❌')).join('')
    console.log(String(s.source).padEnd(40).slice(0,40), marks, ` ${s.l3Count}/4`)
  }

  await fs.mkdir('reports', { recursive: true })
  const report = { generatedAt: new Date().toISOString(), quality: QUALITY, probes: PROBES, results, summary }
  await fs.writeFile('reports/health.json', JSON.stringify(report, null, 2) + '\n')

  // markdown 报告
  const md = [
    `# 音源可用性巡检 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
    '`✅` = L3 通过（真能播）  `⚠` = 有 URL 但播不了  `❌` = 无 URL', '',
    '| 音源 | wy | tx | kw | kg | 可用数 |', '|---|:--:|:--:|:--:|:--:|:--:|',
    ...summary.map(s => {
      const marks = ['wy','tx','kw','kg'].map(p => {
        const r = s.platforms[p]
        return r?.l3 ? '✅' : (r?.l1 ? '⚠' : '❌')
      })
      return `| ${s.source} | ${marks.join(' | ')} | ${s.l3Count}/4 |`
    }),
    '', '## 明细', '',
    '| 音源 | 平台 | L1 | L2 | L3 | 说明 |', '|---|:--:|:--:|:--:|:--:|---|',
    ...results.map(r => `| ${r.source} | ${r.platform} | ${r.l1?'✅':'❌'} | ${r.l2?'✅':'❌'} | ${r.l3?'✅':'❌'} | ${r.detail} |`),
  ].join('\n')
  await fs.writeFile('reports/health.md', md + '\n')
  console.log('\n✅ 已写入 reports/health.json 和 reports/health.md')
}
