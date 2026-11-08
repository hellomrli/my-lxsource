import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { installProbe } from '../integrations/lxserver/install-probe.mjs'
import createAudioProbe from '../integrations/lxserver/audio-probe.cjs'
import { tempDir } from './helpers.mjs'

const hostCode = `const proxy_js_1 = require('./proxy.js');
const lxUtils = { buffer: {} }; module.exports = lxUtils;`

test('lxserver installation exposes the probe, preserves a backup, and is repeatable', async t => {
  const dir = await tempDir(t), target = path.join(dir, 'userApi.js')
  await fs.writeFile(target, hostCode)
  const first = await installProbe(target)
  assert.equal(await fs.readFile(first.backup, 'utf8'), hostCode)
  const installed = await fs.readFile(target, 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(installed, { module,
    require: name => name.endsWith('audio-probe.cjs') ? createAudioProbe : { getProxyAgent() {} } })
  assert.equal(typeof module.exports.audioProbe, 'function')
  assert.equal((await installProbe(target)).changed, false)
  assert.equal(await fs.readFile(target, 'utf8'), installed)
  assert.equal((await installProbe(target, { check: true })).checked, true)
  await fs.writeFile(path.join(dir, 'audio-probe.cjs'), 'outdated')
  await assert.rejects(installProbe(target, { check: true }), /outdated/)
  await installProbe(target)
  assert.equal((await installProbe(target, { check: true })).checked, true)
})

test('unsupported host layouts and existing native probes are never overwritten', async t => {
  const dir = await tempDir(t), target = path.join(dir, 'userApi.js')
  for (const original of ['module.exports = {}', hostCode.replace('buffer: {}', 'audioProbe: nativeProbe'),
    hostCode + "\nconst unrelated = { audioProbe: require('./audio-probe.cjs')(proxy_js_1.getProxyAgent), };",
  ]) {
    await fs.writeFile(target, original)
    await assert.rejects(installProbe(target), /no files changed/)
    assert.equal(await fs.readFile(target, 'utf8'), original)
  }
  assert.deepEqual(await fs.readdir(dir), ['userApi.js'])
})
