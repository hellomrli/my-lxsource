# my-lxsource

公开项目：每日巡检 **多个** LX 音源上游仓库，
**三层验证**后生成一个自包含的整合音源脚本。

## 为什么需要「三层验证」

洛雪音源脚本被调用时只需返回一个 URL 字符串，宿主并不知道这个 URL 是否真的能播。
实测发现**大量音源脚本会返回 404 的死链**，而客户端/服务端只会把它记为"成功"。

因此本项目对每个 源 × 平台 组合做三层检测：

| 层 | 检测内容 | 失败含义 |
|---|---|---|
| L1 | 脚本加载 + 返回非空 URL | 脚本本身坏了/被删 |
| L2 | URL 连通性（仅 HTTP 200/206；重定向逐跳检查） | 死链、后端接口下线 |
| L3 | 音频魔数 + content-type 排除；无损格式与位深校验 | 错误页/JSON/视频、无损降级 |

**只有 L3 通过才计入「可用」。**

覆盖 `wy/tx/kw/kg/mg` 五个平台和 `128k/320k/flac/flac24bit` 四种音质。
酷狗探针同时携带 `songmid` 与 `hash`；咪咕探针区分 `songmid` 与 `copyrightId`。
每个组合分别记录结果，未声明的音质会标为跳过，不会生成虚假的支持声明。

## 跟踪的上游仓库

| key | 仓库 | 说明 |
|---|---|---|
| `pdone` | [pdone/lx-music-source](https://github.com/pdone/lx-music-source) | 洛雪音乐源（最常见） |
| `lxs` | [hwxlikemi/lxs](https://github.com/hwxlikemi/lxs) | 收集的精选音源，以最新巡检报告为准 |
| `xinghai` | [cdyUuu/lx-music-xinghai-source](https://github.com/cdyUuu/lx-music-xinghai-source) | 星海音乐源 |
| `sixyin-cc` | [cc2415/lx-custom-music-source](https://github.com/cc2415/lx-custom-music-source) | 六音 |
| `shellsec` | [shellsec/lx-music-source](https://github.com/shellsec/lx-music-source) | 多源收集（屿溪/墨澜/杰翔/HYW/长青等） |
| `lingeng` | [Lingeng27/lx-music-1010-source](https://github.com/Lingeng27/lx-music-1010-source) | 1010 音源 |
| `younger` | [younger-lgte1/lx-music-source](https://github.com/younger-lgte1/lx-music-source) | 个人音源，覆盖 QQ/酷我/酷狗 |

## 每日流程

```
fetch-upstream  固定各上游 commit，缓存源码并计算 SHA256 → 得出变更
     ↓
test-sources    对每个 源×平台×音质: L1(取URL) → L2(连通) → L3(音频校验)
     ↓
build           核对完整检测矩阵/runId/报告时间/SHA256，验证子源和整合源，再原子写入产物
     ↓
publish         仅提交 reports/health.md + dist/merged-source.js
```

## 目录

```
.github/workflows/daily.yml   每日定时任务
.github/dependabot.yml       Actions 依赖更新检查
scripts/fetch-upstream.mjs    上游抓取与变更检测
scripts/test-sources.mjs      三层可用性检测
scripts/build-source.mjs     生成整合音源脚本
scripts/lx-runtime.mjs       无头 LX API 兼容运行时
scripts/lx-worker.mjs        无网络、无宿主凭据的隔离子进程
scripts/http.mjs             限时、限量、限制目标地址的 HTTP 通道
scripts/audio.mjs            音频/无损魔数校验（客户端复用）
scripts/source-state.mjs     快照缓存、元数据与共用工具
templates/merged-source.js   整合音源模板（LX 自定义源格式）
tests/                      离线回归测试
config.json                 项目配置（直接修改此文件）
reports/health.md            最新可读巡检报告
dist/merged-source.js        生成的整合音源（供客户端导入）
```

`state.json`、`reports/health.json` 与 `.cache/sources/` 是运行时生成的中间数据，不提交到 Git。
Actions 用缓存保存上次巡检快照，并用保留 7 天的 `diagnostics` 附件保存完整报告；
缓存未命中时会重新发现全部音源，不影响检测和构建。
播放 URL 不写进健康报告，避免将临时签名或查询参数长期公开。
任意上游抓取失败时保留旧快照并中止本轮流程，不把网络故障当作源被删除。

巡检与发布在两个独立的 Actions job 中运行：巡检只有仓库读取权限，
发布 job 只复制并提交指定产物，不执行音源脚本。
巡检前先通过 Node.js 22/24 双版本离线回归测试；Pull Request 只运行离线测试，不抓取上游或发布产物。
Runner 固定为 Ubuntu 24.04，Actions 固定到完整 commit SHA；Dependabot 每月将更新集中到一条 PR，不自动合并。
巡检或构建失败时，工作流会失败，仓库里的上一个成功产物保持不变。
若 `master` 在巡检期间发生更新，发布会停止，避免旧结果覆盖新代码。

## 整合音源的原理

洛雪自定义源脚本**只负责 `musicUrl`（把 songmid 换成播放地址），搜索由客户端 SDK 完成**。
所以「整合」= 把多个 L3 通过的上游脚本内联进一个自包含脚本：每个子源绑定稳定的
`globalThis/window/self/global/lx` 作用域，不修改宿主的 `globalThis.lx`；
初始化和播放请求都有超时，晚到的回调不会注册到其他子源。
子源在构建时转换为静态函数，不通过运行时 `eval`/`new Function` 加载，兼容禁止动态代码执行的客户端。
巡检与构建会在禁用字符串代码生成的环境中验证子源和最终产物；依赖动态执行的初始化或播放请求不会计为可用。
允许动态执行的宿主仍保留子源显式使用 `eval`/`Function` 时的作用域兼容处理，但加载器本身不调用它们。
只声明同一份源码实测通过的平台/音质，重复 SHA256 的脚本合并覆盖范围后只加载、嵌入一次。
`embed.maxSources` 限制的是验证通过的独立脚本数；重复脚本和加载失败的候选不占名额。
`embed.maxSourceBytes` / `embed.maxEmbedBytes` 限制单个子源与全部子源的源码字节数
（每份源码在产物中出现两次），超预算的源只做巡检、不嵌入，避免产物超出客户端 2 MiB 上限。

见 `templates/merged-source.js`。

播放时遇到子源卡住、404、HTML 响应或音频校验失败会尝试下一个子源。
有流式 `fetch`/`ReadableStream` 的宿主限量读取 4096 字节并取消请求；缺少流式 API 的 LX 宿主使用
`HEAD` 检查 HTTP 状态与音频 content-type，避免宿主忽略 Range 后下载整首歌。
`HEAD` 无法检查魔数/位深，因此这类宿主不声明或接受 `flac24bit`；普通 FLAC 仅能核对 content-type。
部分 CDN 不支持 `HEAD`，这类探测失败会继续回退，不会被当作验证成功。
所有宿主的 L3/位深都在每日巡检中检查；巡检通过仍不保证所有曲目或一天内不会失效。

客户端作用域隔离解决兼容性与串扰，不是恶意 JavaScript 的安全边界。
同步死循环无法在同一 LX JavaScript 线程内抢占；巡检进程使用独立 OS 沙箱来处理这类故障。

## 用法

1. 在 Actions 里手动跑一次，或等每日定时
2. 看 `reports/health.md` 了解各源状态
3. 客户端导入 `dist/merged-source.js` 的 raw 地址：

   `https://raw.githubusercontent.com/hellomrli/my-lxsource/master/dist/merged-source.js`

客户端保存的是已导入脚本的本地副本，GitHub 更新不会自动替换它。
如果旧版本提示 `Dynamic code execution is not allowed`，删除旧的「我的聚合音源」后重新导入最新地址即可；
无需关闭客户端的动态执行安全限制。

## 本地运行

需要 Linux、Node.js 22.13 或更新版本，以及 `bubblewrap` 和 `prlimit`（util-linux）。
CI 使用 Node.js 22/24 测试、Node.js 24 巡检；没有第三方 npm 依赖。运行时不会回退到不安全的本机执行。

```sh
sudo apt-get install bubblewrap util-linux
npm test
```

`npm test` 是离线回归测试，仅执行仓库自带的模拟脚本；默认不访问公网。
真实巡检在 OS 沙箱安装成功后运行：

```sh
npm run all
```

也可以按 `npm run fetch` → `npm run health` → `npm run build` 的顺序执行。
首次运行必须先抓取、再巡检，不能只依赖仓库中保留的可读报告构建。
`config.json` 可设置子源/总请求/验证超时、报告最长有效期和巡检并发数；
可用 `health.probes` 提供五个平台的探针元数据，默认探针在 `scripts/test-sources.mjs`。

## 安全说明

- 仓库公开，产物不含任何服务器凭据
- `node:vm` 只模拟 LX API。真正边界为每个源独立的 bubblewrap OS 进程：不挂载 home/项目、不继承凭据、隔离 PID/网络、禁用子进程与原生扩展，并限制 CPU/内存/计时器/IPC
- 上游请求通过可信父进程 HTTP 通道，DNS 地址在连接时固定并检查；私网、回环、保留地址、云元数据与重定向到这些地址均被拒绝
- 超时包括 DNS、响应头、重定向和响应体；普通 API 响应限制 1 MiB，源码 2 MiB，音频只读取前 4096 字节
- OS 沙箱不能防范内核漏洞；仍建议使用不带敏感凭据的临时 runner，不给巡检 job 写库权限
- 仅接受固定 commit 的源码且逐步核对 SHA256、巡检 runId 和报告时间；加载失败或无健康候选时保留上一个成功产物
- 生成脚本不依赖自建 lxserver 代理，但各子源仍会访问自己的上游 API
