# TODO：把「代理模式」改造成「嵌入模式」

> 状态：已完成（2026-10-19）。本文保留作设计记录；文中的服务器地址、密码等已脱敏。
>
> 本文档是给下一个会话的交接说明。读完这里就能直接开工，不需要回溯历史。

## 背景

`lx-source-guard` 每天巡检 4 个上游仓库、27 个 LX 音源，做三层可用性验证：

| 层 | 内容 |
|---|---|
| L1 | 脚本能加载并返回非空 URL |
| L2 | URL 可连通 |
| L3 | 返回的是真音频（content-type + 文件魔数） |

当前有效结论（2026-10-18）：

```
lxs:念心音源-V1.0.1.js      ✅ ✅ ✅ ⚠   3/4  ← 最佳
lxs:溯音音源 v1.js          ✅ ❌ ✅ ❌   2/4
xinghai:...v2.3.12.js      ✅ ❌ ✅ ❌   2/4
pdone:qdy/latest.js        ✅ ⚠  ⚠  ⚠   1/4
其余 23 个                  基本全挂
```

117 的 lxserver 目前导入 13 个源，按「念心 → 溯音 → 全豆要 → …」排序，
端到端实测 **wy/tx/kw/kg 可播，mg 只能搜**。

## 当前的问题（为什么必须改）

`dist/merged-source.js` 现在是**代理模式**：

```js
const BACKENDS = [{ type: 'lxserver', baseUrl: 'http://<lxserver-host>:9527', auth: '<管理密码>' }]
// 请求时 POST /api/music/url，靠 x-frontend-auth 认证
```

缺陷：
1. **必须嵌入 lxserver 的管理密码**（安全风险，也阻碍仓库公开）
2. **绕圈子**：脚本 → 网络请求 → lxserver → 13 个源降级，延迟叠加
3. 离开了 lxserver 就完全不可用

## 目标（用户明确要求）

**把可用源的逻辑真正合并进一个自包含脚本，再喂回 lxserver。**
这样 lxserver 只加载 1 个源，不再跑降级链。

```
dist/merged-source.js   ← 自包含，无密码，内含念心/溯音等源的逻辑
        ↓ 导入
      lxserver         ← 只启用这 1 个源
```

## 合并机制（已验证可行，2026-10-18 实测）

关键洞察：**LX 自定义源之间无法互相调用**，但每个源只依赖 `globalThis.lx`。
所以在合并时给每个子源套一层独立的 `lx` shim，收集它的 handler：

```js
for (const [key, code] of subScripts) {
  const handlers = []
  let declared = null
  const shim = {
    ...realLx,
    on:   (ev, h) => { if (ev === realLx.EVENT_NAMES.request) handlers.push(h) },
    send: (ev, d) => { if (ev === realLx.EVENT_NAMES.inited) resolveInited(d?.sources || {}) },
  }
  globalThis.lx = shim
  try { new Function(code)() } finally { globalThis.lx = realLx }
  await initedPromise          // ← 关键：必须 await，见下
  registry.push({ key, handlers, declared })
}
```

分发时按优先级遍历 registry，第一个返回合法 URL 的就是结果：

```js
for (const s of registry) {
  if (!s.declared?.[source] || !s.handlers.length) continue
  try {
    const u = await s.handlers[0]({ source, action: 'musicUrl', info: { type: quality, musicInfo } })
    if (typeof u === 'string' && /^https?:\/\//.test(u)) return u
  } catch { /* 试下一个 */ }
}
```

**实测验证**（用 `溯音音源`）：

```
wy  ✅ http://m701.music.126.net/...
kw  ✅ http://kw-er.kuwo.cn/...
```

## 已知坑

### 坑 1：`inited` 是异步的，必须 await

`念心音源` 会先请求 `VERSION_CHECK_URL`，拿到结果后才 `send(inited)`。
同步读取时 `declared` 是空的，导致该源被跳过（tx 平台因此失败）。

**解法**：每个子源加载后 await 它的 `send(inited)`，超时 30s。
`scripts/lx-runtime.mjs` 里的 `loadSource()` 已经实现了这个等待，直接复用。

### 坑 2：脚本必须能读到 `globalThis.lx`

子源顶部通常写 `const {EVENT_NAMES, request, on, send} = globalThis.lx`。
所以必须在执行前替换 `globalThis.lx`，执行后恢复。

### 坑 3：未处理的 Promise 拒绝会带崩进程

这些混淆脚本内部常用 `Promise.any` 且不处理全部失败。
入口处必须加 `process.on('unhandledRejection', () => {})`。

### 坑 4：`resp.body` 要按 content-type 自动 JSON 解析

部分源写 `resp.body.code != 200`（当对象用），部分写 `resp.body.match(...)`（当字符串用）。
LX 宿主的实际行为是：JSON 响应自动解析为对象，其余保留字符串。
`scripts/lx-runtime.mjs` 的 `httpRequest` 已实现。

### 坑 5：中文文件名要 URL 编码

上游文件名含中文（`念心音源-V1.0.1.js`），拼 raw URL 时必须逐段 `encodeURIComponent`。

## 实施步骤

1. **改 `scripts/build-source.mjs`**
   - 新增 `mode: "embed"` 配置项
   - 从 `reports/health.json` 里挑出 L3 通过的源（按可用平台数排序）
   - 下载它们的源码，内联进输出脚本
   - 输出脚本结构：
     ```
     /*! @name ... */
     const { EVENT_NAMES, request, on, send } = globalThis.lx
     const SUBS = [
       { key: 'nx', name: '念心音源', platforms: ['wy','tx','kw','kg','mg'], code: `...` },
       { key: 'sy', name: '溯音音源', platforms: ['wy','kw'], code: `...` },
     ]
     // 逐个子源建立 shim，收集 handler（异步 await inited）
     // on(EVENT_NAMES.request, ...) 里按优先级分发
     // send(EVENT_NAMES.inited, { sources: 各子源声明平台的并集 })
     ```
   - **注意**：子源代码要以字符串形式内联（`JSON.stringify(code)` 后用 `new Function` 执行），
     避免变量名冲突和 `const` 重复声明

2. **删掉 lxserver 代理后端**
   - `config.json` 的 `backends` 改为空或直接移除 `lxserver` 类型
   - `LXSERVER_AUTH` secret 可以删除

3. **验证**
   - 本地 `node scripts/build-source.mjs` 生成
   - 用 `scripts/lx-runtime.mjs` 的 `loadSource()` 加载生成的脚本
   - 对 wy/tx/kw/kg 各取一个 URL，用 `verifyAudioUrl()` 确认 L3 通过

4. **回灌 lxserver**
   - 把生成的脚本上传到可访问的 URL，或直接用 `/api/custom-source/upload` 接口上传文件
   - 在 lxserver 里**只启用这一个整合源**，其余全部停用
   - 端到端测 5 个平台，对比改造前的耗时

5. **更新 CI**
   - `.github/workflows/daily.yml` 里 `build merged source` 步骤不再需要 `LXSERVER_AUTH`
   - 生成的 `dist/merged-source.js` 不含任何凭据，可以安全公开

## 相关文件

| 文件 | 说明 |
|---|---|
| `scripts/lx-runtime.mjs` | 无头 LX 运行时，`loadSource()` 可直接复用于子和测试 |
| `scripts/fetch-upstream.mjs` | 多仓库抓取（4 个仓库，27 个源） |
| `scripts/test-sources.mjs` | 三层巡检 |
| `scripts/build-source.mjs` | 已改造：嵌入模式，生成自包含脚本 |
| `templates/merged-source.js` | 已改造：嵌入模式模板 |
| `reports/health.json` | 最近一次巡检的完整结果（含每个 源×平台 的 L1/L2/L3） |

## 环境信息

- 上游仓库：`pdone/lx-music-source`(main)、`hwxlikemi/lxs`(main)、`cdyUuu/lx-music-xinghai-source`(main)、`cc2415/lx-custom-music-source`(main)
- 测试目标 lxserver：`http://<lxserver-host>:9527`，管理员密码由私有部署环境保管
- 公开入口：`https://<public-entry>`，播放器密码 `<redacted>`
- 注意：Lucky 反代**不支持 WebSocket 升级**，LX 同步功能要走直连 `http://<lxserver-host>:9527/qmusic`
