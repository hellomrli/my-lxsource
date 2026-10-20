import { randomUUID } from 'node:crypto'
import { requestText } from './http.mjs'
import { parseMeta, cacheScript, readJson, atomicWrite, isMain } from './source-state.mjs'

export const UPSTREAMS = {
  pdone: { repo: 'pdone/lx-music-source', branch: 'main' },
  lxs: { repo: 'hwxlikemi/lxs', branch: 'main' },
  xinghai: { repo: 'cdyUuu/lx-music-xinghai-source', branch: 'main' },
  'sixyin-cc': { repo: 'cc2415/lx-custom-music-source', branch: 'main' },
}
const encodePath = value => value.split('/').map(encodeURIComponent).join('/')
const githubHeaders = { 'User-Agent': 'my-lxsource', Accept: 'application/vnd.github+json' }

async function fetchRepo(key, { repo, branch }, { download, cacheDir }) {
  const commitInfo = JSON.parse(await download(`https://api.github.com/repos/${repo}/commits/${branch}`, { headers: githubHeaders }))
  const commit = commitInfo.sha
  if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error(`Invalid commit for ${repo}`)
  const tree = JSON.parse(await download(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, { headers: githubHeaders }))
  if (tree.truncated) throw new Error(`Incomplete Git tree for ${repo}`)
  const paths = (tree.tree || []).filter(entry => entry.type === 'blob').map(entry => entry.path)
  let candidates = paths.filter(p => /(^|\/)latest\.js$/.test(p))
  if (!candidates.length) candidates = paths.filter(p => p.endsWith('.js') && !/^(src|node_modules)\//.test(p))
  if (candidates.length > 40) throw new Error(`Too many scripts in ${repo}; explicit discovery rules required`)
  const sources = {}
  for (const scriptPath of candidates.sort()) {
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${encodePath(scriptPath)}`
    const code = await download(url, { headers: { 'User-Agent': 'my-lxsource' }, maxBytes: 2097152 })
    if (!code.trim()) throw new Error(`Empty source ${repo}:${scriptPath}`)
    const hash = await cacheScript(code, cacheDir)
    const meta = parseMeta(code)
    sources[`${key}:${scriptPath}`] = {
      repo, branch, commit, path: scriptPath, url, sha256: hash, size: Buffer.byteLength(code),
      name: meta.name || scriptPath, version: meta.version || '', author: meta.author || '',
    }
  }
  return { sources, head: { repo, branch, commit, date: commitInfo.commit?.committer?.date || null } }
}

export async function fetchUpstream({ upstreams = UPSTREAMS, download = requestText,
  cacheDir = '.cache/sources' } = {}) {
  const sources = {}, heads = {}, failures = []
  for (const [key, cfg] of Object.entries(upstreams)) {
    try {
      const result = await fetchRepo(key, cfg, { download, cacheDir })
      Object.assign(sources, result.sources)
      heads[key] = result.head
    } catch (error) { failures.push(`${key}: ${error.message}`) }
  }
  // A network failure is not evidence that upstream sources were deleted.
  if (failures.length) throw new Error(`Incomplete upstream snapshot; previous state preserved\n${failures.join('\n')}`)
  if (!Object.keys(sources).length) throw new Error('No upstream sources discovered; previous state preserved')
  return { heads, sources, discovered: Object.keys(sources) }
}

export function diffState(prev, cur) {
  const changes = { added: [], updated: [], removed: [], unchanged: [] }
  const before = prev?.sources || {}, after = cur?.sources || {}
  for (const [key, value] of Object.entries(after)) {
    if (!before[key]) changes.added.push(key)
    else if (before[key].sha256 !== value.sha256) changes.updated.push(key)
    else changes.unchanged.push(key)
  }
  for (const key of Object.keys(before)) if (!after[key]) changes.removed.push(key)
  return changes
}

export async function runFetch(options = {}) {
  const statePath = options.statePath || 'state.json'
  const previous = await readJson(statePath, {})
  const snapshot = await fetchUpstream(options)
  const changes = diffState(previous, snapshot)
  const state = { schemaVersion: 2, runId: randomUUID(), lastRun: new Date().toISOString(),
    heads: snapshot.heads, sources: snapshot.sources, changes }
  await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n')
  console.log(`Discovered ${snapshot.discovered.length} sources; added ${changes.added.length}, updated ${changes.updated.length}, removed ${changes.removed.length}`)
  return state
}

if (isMain(import.meta.url)) {
  try { await runFetch() }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
