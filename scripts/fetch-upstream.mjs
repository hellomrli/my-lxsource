/** 拉取上游音源列表并检测变更 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

// 多上游仓库；中文脚本路径会被自动编码。
const UPSTREAMS = {
  'pdone':        { repo: 'pdone/lx-music-source',       branch: 'main'   },
  'lxs':          { repo: 'hwxlikemi/lxs',               branch: 'main'   },
  'xinghai':      { repo: 'cdyUuu/lx-music-xinghai-source', branch: 'main' },
  'sixyin-cc':    { repo: 'cc2415/lx-custom-music-source',  branch: 'main' },
}
const UPSTREAM = UPSTREAMS['pdone'].repo

async function ghJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lx-source-guard', Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'lx-source-guard' } })
  if (!res.ok) return null
  return res.text()
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/')

/** 抓取单个仓库的所有 *latest.js 或 *.js 顶层脚本 */
async function fetchRepo(key, cfg) {
  const { repo, branch } = cfg
  let paths = []
  try {
    const tree = await ghJson(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`)
    paths = (tree.tree || []).map(t => t.path)
  } catch (e) {
    return { error: e.message, sources: {} }
  }
  // 优先 latest.js；否则取顶层/一层目录下的 .js
  let candidates = paths.filter(p => /(^|\/)latest\.js$/.test(p))
  if (!candidates.length) {
    candidates = paths.filter(p => p.endsWith('.js') && !p.startsWith('src/') && !p.startsWith('node_modules/'))
  }
  const sources = {}
  for (const p of candidates.slice(0, 40)) {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${encPath(p)}`
    const body = await fetchText(url)
    if (!body) continue
    const id = `${key}:${p}`
    sources[id] = {
      repo, path: p, url,
      sha256: sha256(body),
      size: body.length,
      name: (body.match(/@name\s+([^\n*]+)/) || [])[1]?.trim() || p,
      version: (body.match(/@version\s+([^\n*]+)/) || [])[1]?.trim() || '',
      author: (body.match(/@author\s+([^\n*]+)/) || [])[1]?.trim() || '',
    }
  }
  return { sources }
}

export async function fetchUpstream() {
  const sources = {}
  let headCommit = null, headDate = null
  for (const [key, cfg] of Object.entries(UPSTREAMS)) {
    const r = await fetchRepo(key, cfg)
    Object.assign(sources, r.sources || {})
    try {
      const commits = await ghJson(`https://api.github.com/repos/${cfg.repo}/commits?sha=${cfg.branch}&per_page=1`)
      if (!headCommit) { headCommit = commits[0]?.sha || null; headDate = commits[0]?.commit?.committer?.date || null }
    } catch {}
  }
  const names = Object.keys(sources)
  return { headCommit, headDate, sources, discovered: names }
}

export function diffState(prev, cur) {
  const changes = { added: [], updated: [], removed: [], unchanged: [] }
  const prevS = prev?.sources || {}
  const curS = cur?.sources || {}
  for (const [k, v] of Object.entries(curS)) {
    if (!prevS[k]) changes.added.push(k)
    else if (prevS[k].sha256 !== v.sha256) changes.updated.push(k)
    else changes.unchanged.push(k)
  }
  for (const k of Object.keys(prevS)) if (!curS[k]) changes.removed.push(k)
  return changes
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const statePath = 'state.json'
  const prev = JSON.parse(await fs.readFile(statePath, 'utf8').catch(() => '{}'))
  const cur = await fetchUpstream()
  const changes = diffState(prev, cur)

  console.log(`上游 HEAD: ${cur.headCommit?.slice(0, 8) ?? '?'}  (${cur.headDate ?? '?'})`)
  console.log(`发现音源: ${cur.discovered.length} 个`)
  console.log(`  新增: ${changes.added.join(', ') || '无'}`)
  console.log(`  更新: ${changes.updated.join(', ') || '无'}`)
  console.log(`  移除: ${changes.removed.join(', ') || '无'}`)
  console.log(`  未变: ${changes.unchanged.length} 个`)

  const next = {
    lastRun: new Date().toISOString(),
    upstreamRepo: UPSTREAM,
    headCommit: cur.headCommit,
    headDate: cur.headDate,
    sources: cur.sources,
    changes,
  }
  await fs.writeFile(statePath, JSON.stringify(next, null, 2) + '\n')
  console.log('✅ 已写入 state.json')
}
