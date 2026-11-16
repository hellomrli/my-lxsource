# 维护巡检与发布

本页用于运行 my-lxsource、修改检测预算和排查流水线。需要 Linux、Node.js 26.13.0 或更新版本、bubblewrap 和 util-linux 的 prlimit；命令在仓库根目录运行。

## 按顺序运行

先执行 `npm test` 验证仓库自带的离线模拟脚本。真实巡检按以下顺序执行：

```bash
npm run fetch
npm run health
npm run build
```

`npm run all` 包含上述三步。首次运行必须抓取并生成匹配的 JSON 巡检报告，仓库中保留的可读 Markdown 报告不能单独用于构建。

| 步骤 | 输入与结果 |
|---|---|
| fetch | 固定上游 commit，缓存源码、计算 SHA256，生成 `state.json` |
| health | 对源、平台、音质和歌曲逐项检查，写入 `reports/health.json` 与 `.md` |
| build | 核对报告、选择子源、验收完整整合包，生成播放报告与 `dist/merged-source.js` |

`state.json`、`reports/*.json` 和 `.cache/sources/` 是不提交的中间数据。源码固定到 commit，读取时再次核对 SHA256。

## 每日任务的重试与保留

Actions 使用 `npm run daily` 顺序执行抓取、巡检和构建，并区分上游不可用与程序错误：

| 情况 | 每日处理 |
|---|---|
| 上游抓取出现已识别的 HTTP 或网络故障 | 最多执行 3 次，重试前分别等待 2 秒、5 秒 |
| 巡检没有任何 L3 通过的源 | 执行 1 次，跳过构建；不重复整轮耗时巡检 |
| 整合包的播放样本未通过 | 最多构建、验收 2 次，重试前等待 5 秒 |
| 上述故障在尝试结束后仍未恢复 | 任务正常结束，记录“本轮未更新”，保留原脚本并跳过发布 |
| 离线测试、配置、沙箱、源码 SHA、报告匹配或整合包初始化出错 | 任务失败，停止发布，不按上游故障重试 |

`reports/daily.json` 记录每次尝试、最终状态和原脚本的时间与 SHA；`.md` 写入 Actions 的任务摘要。`ready` 表示本轮具备发布条件，`retained` 表示未更新，`error` 表示需要修复的错误。这些每日报告不提交到仓库；首页的报告始终对应最后一次成功发布。

发布前还会检查本轮快照、巡检和播放报告的时间、完整结果及 SHA，避免把旧报告当成本轮成功。保留旧版不代表旧版已重新验证，也不保证旧版现在仍可播放。

`npm run all` 与三个独立步骤仍保持严格模式：预期的上游不可用退出码为 2，程序或配置错误为 1。只有每日编排器会把明确的上游不可用转换为正常跳过更新。

## 修改配置

编辑 [config.json](../config.json)。配置分为 `embed` 和 `health`：

- `embed` 控制初始化、取地址、验证和总请求预算，失败冷却、报告有效期、源码数量及字节上限。
- `health.concurrency` 控制巡检并发，巡检复用播放的取地址和验证预算。
- `health.probes` 可为五个平台分别提供 2–5 首不同歌曲；字段和校验规则见 [probes.mjs](../scripts/probes.mjs)。

酷狗探针需同时有 `songmid` 与 `hash`；咪咕需独立的 `copyrightId`；曲目还需 `songmid/name/singer`。修改预算或探针后重新执行巡检，构建会拒绝旧的、不完整的或政策不一致的报告。

## 查看 Actions 结果

[daily.yml](../.github/workflows/daily.yml) 将离线测试、真实巡检和发布分成不同 job。每天北京时间 04:00 触发；Pull Request 只跑离线测试；手动和指定代码变更也可触发真实巡检。

巡检 job 的仓库权限是只读；只有本轮 `ready=true` 且检查成功，才上传发布附件并启动发布 job，复制和提交健康报告、播放报告与整合脚本。`diagnostics` 附件保留 7 天，包含每日报告、快照和本轮实际产生的巡检、播放 JSON；跳过的阶段不附上旧 Markdown。状态缓存未命中时重新发现上游。

抓取步骤使用 Actions 自动提供的临时 `GITHUB_TOKEN` 访问 GitHub API，避免共享 runner 的匿名请求额度耗尽。
认证头只发送给 `api.github.com`，不用于源码下载，也不写入缓存、快照或报告。每日编排器仅将令牌交给抓取子进程，巡检与构建子进程会移除 `GITHUB_TOKEN` 和 `GH_TOKEN`。
本地也可为 `npm run fetch` 单独设置 `GITHUB_TOKEN`；未设置时使用匿名请求额度。

任务显示“本轮未更新”时，先查看摘要和 `diagnostics` 中的 `daily.md`。任务失败时先定位步骤，再对应处理：

| 错误或步骤 | 处理 |
|---|---|
| 上游 Download HTTP 403、404 或网络异常 | 核查 GitHub API 认证、额度、上游仓库和网络；部分抓取失败保留旧快照，每日任务在有限重试后跳过本轮 |
| OS sandbox preflight failed | 检查 bubblewrap、prlimit 与 Linux 用户命名空间是否可用 |
| Too many pending HTTP requests | 查看上游多路请求是否持续堆积；每沙箱 16 个请求运行、最多 48 个排队，排队仍受原超时限制 |
| 报告过期、runId 或 SHA256 不匹配 | 重新按 fetch、health、build 顺序运行 |
| No healthy sources | 查看各曲目的 L1/L2/L3 明细，不把返回 URL 当成音频成功 |
| Merged playback validation failed | 查看失败的宿主、平台和音质；整合包未满足发布条件 |
| master 在巡检期间前进 | 正常跳过旧提交的发布，等待最新代码的巡检；git 或认证错误仍会使发布失败 |

整合包验收失败时，`diagnostics` 中的 `reports/playback.json` 保存本轮结果，包括失败组合和逐曲明细；`reports/daily.md` 汇总失败原因。HEAD 内容类型错误会记录实际 MIME，便于区分 CDN 错标与真实错误页面。每次验收仍在本地生成完整 `playback.md`，但只有成功发布才更新仓库首页的报告；排查失败应查看对应运行的附件。

## 更新客户端副本

GitHub 成功发布后，在客户端重新导入首页的 raw 地址。首次导入或显示列表异常时，同时检查宿主的公共源权限；lxserver 的 `enablePublicSources` 和用户权限说明见[集成指南](../integrations/lxserver/README.md)。

返回[文档索引](index.md)。
