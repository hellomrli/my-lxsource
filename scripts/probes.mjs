import { PLATFORMS } from './source-state.mjs'

// Native IDs checked against the platforms' search metadata. Keep different
// artists/catalogues so one song cannot stand in for a platform's availability.
export const PROBES = {
  wy: [
    { musicInfo: { songmid: '2652820720', name: '晴天(深情版)', singer: 'Lucky小爱', source: 'wy', interval: '04:38' } },
    { musicInfo: { songmid: '1357375695', name: '海阔天空', singer: 'Beyond', source: 'wy', interval: '03:59' } },
  ],
  tx: [
    { musicInfo: { songmid: '0039MnYb0qxYhV', name: '晴天', singer: '周杰伦', source: 'tx', interval: '04:29' } },
    { musicInfo: { songmid: '001yS0N33yPm1B', songId: 4835784, strMediaMid: '002MX8Ea4e5RDS', name: '海阔天空', singer: 'BEYOND', source: 'tx', interval: '05:24' } },
  ],
  kw: [
    { musicInfo: { songmid: '228908', name: '晴天', singer: '周杰伦', source: 'kw', interval: '04:29' } },
    { musicInfo: { songmid: '5886682', name: '海阔天空', singer: 'BEYOND', source: 'kw', interval: '05:24' } },
  ],
  kg: [
    { musicInfo: { songmid: 'B3A52A7A958BF0AED0EBFBA2E9A818B7', hash: 'B3A52A7A958BF0AED0EBFBA2E9A818B7', name: '晴天', singer: '周杰伦', source: 'kg', interval: '04:29' } },
    { musicInfo: { songmid: 'C41E80A18D1448FA47086372999C7F43', hash: 'C41E80A18D1448FA47086372999C7F43', name: '海阔天空', singer: 'BEYOND', source: 'kg', interval: '05:24' } },
  ],
  mg: [
    { musicInfo: { songmid: '3790007', copyrightId: '60054701923', name: '晴天', singer: '周杰伦', source: 'mg', interval: '04:30' } },
    { musicInfo: { songmid: '1135162566', copyrightId: '6005752DXKE', name: '海阔天空', singer: 'Beyond', source: 'mg', interval: '03:59' } },
  ],
}

export function normalizeProbes(input = PROBES) {
  const probes = {}
  for (const platform of PLATFORMS) {
    const list = input?.[platform]
    if (!Array.isArray(list) || list.length < 2 || list.length > 5) {
      throw new Error(`Provide 2–5 distinct probe songs for ${platform}`)
    }
    const ids = new Set(), songs = new Set()
    probes[platform] = list.map(probe => {
      const info = probe?.musicInfo
      if (!info?.songmid || !info.name || !info.singer ||
        (platform === 'kg' && !info.hash) || (platform === 'mg' && !info.copyrightId)) {
        throw new Error(`Incomplete probe metadata for ${platform}`)
      }
      const id = probe.id || `${platform}:${info.songmid}`
      const song = String(platform === 'kg' ? info.hash : platform === 'mg' ? info.copyrightId : info.songmid)
      if (typeof id !== 'string' || !/^[\w:-]{1,100}$/.test(id) || ids.has(id) || songs.has(song)) {
        throw new Error(`Duplicate or invalid probe identity for ${platform}`)
      }
      ids.add(id); songs.add(song)
      return { id, source: platform, musicInfo: { ...structuredClone(info), source: platform } }
    })
  }
  return probes
}
