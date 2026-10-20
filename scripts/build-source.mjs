/** 根据健康报告生成「嵌入模式」的自包含整合音源脚本 */
import fs from 'node:fs/promises'
import { loadSource } from './lx-runtime.mjs'

const PLATFORM_META = {
  wy: { name: '网易云音乐', quals: ['128k', '320k', 'flac', 'flac24bit'] },
  tx: { name: 'QQ音乐',     quals: ['128k', '320k', 'flac', 'flac24bit'] },
  kw: { name: '酷我音乐',   quals: ['128k', '320k', 'flac', 'flac24bit'] },
  kg: { name: '酷狗音乐',   quals: ['128k', '320k', 'flac', 'flac24bit'] },
  mg: { name: '咪咕音乐',   quals: ['128k', '320k', 'flac', 'flac24bit'] },
}
const PLATFORM_ORDER = Object.keys(PLATFORM_META)

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/** JSON 字符串化并转义 JS 里不安全的行分隔符 */
function safeJson(value, indent) {
  return JSON.stringify(value, null, indent)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function sortPlatforms(list) {
  const set = new Set(list)
  return [
    ...PLATFORM_ORDER.filter((p) => set.has(p)),
    ...[...set].filter((p) => !PLATFORM_ORDER.includes(p)).sort(),
  ]
}

function rawUrl(entry) {
  if (!entry?.repo || !entry?.path) return null
  const path = entry.path.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${entry.repo}/${entry.branch || 'main'}/${path}`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = await readJson('config.json', {})
  const mode = cfg.mode || 'embed'
  if (mode !== 'embed') {
    console.error(`❌ 不支持的模式: ${mode}（build-source.mjs 当前只实现了 embed 模式）`)
    process.exit(1)
  }

  const report = await readJson('reports/health.json')
  if (!report?.results?.length) {
    console.error('❌ reports/health.json 不存在或没有 results，请先跑 test-sources')
    process.exit(1)
  }
  const state = await readJson('state.json', {})

  // 统计每个源的 L3 通过平台和声明支持的平台
  const health = new Map()
  for (const r of report.results) {
    let e = health.get(r.source)
    if (!e) {
      e = { id: r.source, l3: new Set(), supported: new Set() }
      health.set(r.source, e)
    }
    if (r.detail !== '不支持该平台') e.supported.add(r.platform)
    if (r.l3) e.l3.add(r.platform)
  }

  // 只取至少有一个 L3 通过的源；按可用平台数排序（同分时覆盖平台多的优先）
  let candidates = [...health.values()].filter((e) => e.l3.size > 0)
  candidates.sort((a, b) =>
    b.l3.size - a.l3.size ||
    b.supported.size - a.supported.size ||
    a.id.localeCompare(b.id))

  const maxSources = Number(cfg.embed?.maxSources) || 0
  if (maxSources > 0) candidates = candidates.slice(0, maxSources)

  const initTimeoutMs = Number(cfg.embed?.initTimeoutMs) || 30000
  const probeTimeoutMs = Number(cfg.embed?.probeTimeoutMs) || 15000

  console.log(`模式: ${mode}`)
  console.log(`L3 通过的源: ${candidates.length} 个`)
  for (const e of candidates) {
    console.log(`  ${e.id}  L3: ${[...e.l3].join(',') || '-'}  声明: ${[...e.supported].join(',') || '-'}`)
  }
  if (!candidates.length) {
    console.error('\n❌ 没有任何 L3 通过的源，保留现有 dist/merged-source.js 不覆盖')
    process.exit(1)
  }

  // 下载源码；构建时实际加载一次，取得每个子源真正声明的平台（含 mg 等未巡检平台）
  const loaded = await pool(candidates, 3, async (h) => {
    const info = state.sources?.[h.id] || {}
    const url = info.url || rawUrl(info)
    if (!url) {
      console.warn(`  ⚠ 跳过 ${h.id}: 找不到下载地址`)
      return null
    }
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'lx-source-guard' } })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
      const code = await res.text()
      const rt = await loadSource(code, { timeoutMs: probeTimeoutMs })
      if (rt.error) {
        console.warn(`  ⚠ ${h.id} 构建期加载失败（回退到巡检平台）: ${rt.error}`)
      }
      const platforms = sortPlatforms(rt.error || !rt.sources ? [...h.supported] : Object.keys(rt.sources))
      if (!platforms.length) {
        console.warn(`  ⚠ 跳过 ${h.id}: 没有声明任何平台`)
        return null
      }
      return {
        key: h.id,
        name: rt.meta?.name || info.name || h.id,
        version: rt.meta?.version || info.version || '',
        description: rt.meta?.description || '',
        author: rt.meta?.author || info.author || '',
        homepage: rt.meta?.homepage || '',
        platforms,
        l3: [...h.l3].filter((p) => platforms.includes(p)),
        code,
      }
    } catch (err) {
      console.warn(`  ⚠ 跳过 ${h.id}: ${err.message}`)
      return null
    }
  })

  const subs = loaded.filter(Boolean)
  if (!subs.length) {
    console.error('\n❌ 所有候选源都下载/加载失败，保留现有 dist/merged-source.js 不覆盖')
    process.exit(1)
  }

  // 声明平台 = 所有子源声明平台的并集
  const platformSet = new Set(subs.flatMap((s) => s.platforms))
  const union = sortPlatforms(platformSet)
  const sources = {}
  for (const p of union) {
    sources[p] = {
      name: PLATFORM_META[p]?.name || p,
      type: 'music',
      actions: ['musicUrl'],
      qualitys: PLATFORM_META[p]?.quals || ['128k', '320k'],
    }
  }

  console.log('\n子源优先级:')
  for (const s of subs) console.log(`  ${s.name} [${s.platforms.join(',')}]  L3: ${s.l3.join(',') || '-'}`)
  console.log(`声明平台: ${union.join(', ')}`)

  const values = {
    NAME: cfg.name || '聚合音源',
    DESCRIPTION: cfg.description || `内嵌 ${subs.length} 个可用音源，按优先级自动降级`,
    VERSION: cfg.version || new Date().toISOString().slice(0, 10),
    AUTHOR: cfg.author || 'lx-source-guard',
    HOMEPAGE: cfg.homepage || '',
    GENERATED_AT: new Date().toISOString(),
    SUB_NAMES: subs.map((s) => s.name).join(' / '),
    SUBS_JSON: safeJson(subs, 2),
    SOURCES_JSON: safeJson(sources, 2),
    INIT_TIMEOUT_MS: String(initTimeoutMs),
  }

  const tpl = await fs.readFile('templates/merged-source.js', 'utf8')
  const out = tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in values ? values[key] : m))

  await fs.mkdir('dist', { recursive: true })
  await fs.writeFile('dist/merged-source.js', out)
  console.log(`\n✅ 已生成 dist/merged-source.js (${out.length} 字节, ${subs.length} 个子源, ${union.length} 个平台)`)
}
