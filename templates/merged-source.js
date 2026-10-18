/*!
 * @name {{NAME}}
 * @description {{DESCRIPTION}}
 * @version {{VERSION}}
 * @author {{AUTHOR}}
 * @homepage {{HOMEPAGE}}
 */
/**
 * 本文件由 lx-source-guard 自动生成，请勿手工修改。
 * 生成时间: {{GENERATED_AT}}
 * 内嵌源: {{SUB_NAMES}}
 *
 * 原理：洛雪自定义源只负责把 songmid 解析成播放地址。
 * 本脚本把多个 L3 通过的上游音源内联进来，每个子源在独立的 lx shim
 * 下加载并收集其 request handler；播放请求按优先级依次尝试，
 * 返回第一个有效的播放地址。
 *
 * 本脚本自包含，不包含任何凭据，也不依赖任何外部后端。
 */
const LX = globalThis.lx
const { EVENT_NAMES, request, on, send } = LX

const SUBS = {{SUBS_JSON}}

const SOURCES = {{SOURCES_JSON}}

// 单个子源等待 send(inited) 的上限
const SUB_INIT_TIMEOUT_MS = {{INIT_TIMEOUT_MS}}

const ENTRIES = SUBS.map((sub) => {
  const entry = { sub, handlers: [], declared: null, status: 'pending', error: null }
  entry.ready = new Promise((resolve) => { entry._resolve = resolve })
  return entry
})

/**
 * 用独立 shim 执行一个子源，收集它的 request handler 和声明平台。
 * 注意：部分子源会在异步回调里再次读取 globalThis.lx，所以同一时刻
 * 只允许一个子源占用 shim（见下面的顺序加载队列）。
 */
function loadEntry(entry) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (status) => {
      if (settled) return
      settled = true
      entry.status = status
      clearTimeout(timer)
      try { globalThis.lx = LX } catch (e) {}
      entry._resolve(entry)
      resolve(entry)
    }
    const shim = {
      version: LX.version,
      env: LX.env,
      platform: LX.platform,
      currentScriptInfo: {
        name: entry.sub.name,
        version: entry.sub.version,
        description: entry.sub.description,
        author: entry.sub.author,
        homepage: entry.sub.homepage,
        rawScript: entry.sub.code,
      },
      EVENT_NAMES: EVENT_NAMES,
      utils: LX.utils,
      request: LX.request,
      on(event, handler) {
        if (event === EVENT_NAMES.request && typeof handler === 'function') entry.handlers.push(handler)
      },
      send(event, data) {
        if (event === EVENT_NAMES.inited) {
          entry.declared = (data && data.sources) || {}
          finish('ready')
        } else if (event === EVENT_NAMES.updateAlert) {
          try { LX.send(event, data) } catch (e) {}
        }
      },
    }
    const timer = setTimeout(() => finish('timeout'), SUB_INIT_TIMEOUT_MS)
    try {
      globalThis.lx = shim
      new Function(entry.sub.code)()
    } catch (err) {
      entry.error = err
      finish('error')
    }
  })
}

let loadQueue = Promise.resolve()
for (const entry of ENTRIES) {
  loadQueue = loadQueue.then(() => loadEntry(entry))
}

on(EVENT_NAMES.request, async ({ source, action, info }) => {
  if (action !== 'musicUrl') throw new Error('仅支持 musicUrl')
  const quality = (info && info.type) || '320k'
  const musicInfo = (info && info.musicInfo) || {}
  const errors = []

  for (const entry of ENTRIES) {
    if (entry.status === 'pending') await entry.ready
    if (entry.status !== 'ready') continue
    if (!entry.declared || !entry.declared[source]) continue
    const handler = entry.handlers[0]
    if (!handler) continue
    try {
      const url = await handler({ source, action: 'musicUrl', info: { type: quality, musicInfo } })
      if (typeof url === 'string' && /^https?:\/\//.test(url)) return url
      errors.push(entry.sub.name + ': 未返回有效地址')
    } catch (err) {
      errors.push(entry.sub.name + ': ' + String((err && err.message) || err).slice(0, 80))
    }
  }

  throw new Error('所有内嵌音源均失败 → ' + (errors.join(' | ') || '没有支持 ' + source + ' 的子源'))
})

send(EVENT_NAMES.inited, {
  sources: SOURCES,
})
