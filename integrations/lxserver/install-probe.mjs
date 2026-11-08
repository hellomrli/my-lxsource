import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const probeFile = fileURLToPath(new URL('./audio-probe.cjs', import.meta.url))
const marker = '// my-lxsource bounded audio probe'
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

async function replaceFile(file, content, mode) {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, content, { mode })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

/** Install only into a recognized compiled CommonJS lxserver host. */
export async function installProbe(target, { check = false } = {}) {
  const file = await fs.realpath(path.resolve(target))
  const original = await fs.readFile(file, 'utf8')
  const probe = await fs.readFile(probeFile, 'utf8')
  const companion = path.join(path.dirname(file), 'audio-probe.cjs')
  const anchors = [...original.matchAll(/\bconst\s+lxUtils\s*=\s*\{/g)]
  const imports = [...original.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*['"][^'"]*\/proxy\.js['"]\s*\)/g)]
  if (anchors.length !== 1 || imports.length !== 1) throw new Error('Unrecognized lxserver layout; no files changed')
  const property = `audioProbe: require('./audio-probe.cjs')(${imports[0][1]}.getProxyAgent),`
  const body = original.slice(anchors[0].index + anchors[0][0].length).trimStart()
  const installed = (body.startsWith(marker) ? body.slice(marker.length).trimStart() : body).startsWith(property)
  if (!installed && /\baudioProbe\s*:/.test(original)) throw new Error('Host already has a different audioProbe; no files changed')
  const updated = installed ? original : original.replace(anchors[0][0], `${anchors[0][0]}\n        ${marker}\n        ${property}`)
  new vm.Script(updated, { filename: file })
  if (check) {
    const current = await fs.readFile(companion, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    if (!installed || current !== probe) throw new Error('Audio probe is missing or outdated; run the installer without --check')
    return { file, changed: false, checked: true }
  }
  let backup
  if (!installed) {
    backup = `${file}.my-lxsource.${digest(original)}.bak`
    await fs.copyFile(file, backup, constants.COPYFILE_EXCL).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  // Install the dependency first; a failed host write leaves its previous code usable.
  await replaceFile(companion, probe, 0o644)
  if (!installed) await replaceFile(file, updated, (await fs.stat(file)).mode)
  return { file, changed: !installed, backup }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), check = args.includes('--check')
  const targets = args.filter(arg => arg !== '--check')
  try {
    if (targets.length !== 1) throw new Error('Usage: node install-probe.mjs /path/to/userApi.js [--check]')
    const result = await installProbe(targets[0], { check })
    console.log(check ? `Audio probe verified: ${result.file}` : `Audio probe installed: ${result.file}; restart lxserver to load it`)
    if (result.backup) console.log(`Backup: ${result.backup}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
