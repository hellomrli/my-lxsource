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

## 修改配置

编辑 [config.json](../config.json)。配置分为 `embed` 和 `health`：

- `embed` 控制初始化、取地址、验证和总请求预算，失败冷却、报告有效期、源码数量及字节上限。
- `health.concurrency` 控制巡检并发，巡检复用播放的取地址和验证预算。
- `health.probes` 可为五个平台分别提供 2–5 首不同歌曲；字段和校验规则见 [probes.mjs](../scripts/probes.mjs)。

酷狗探针需同时有 `songmid` 与 `hash`；咪咕需独立的 `copyrightId`；曲目还需 `songmid/name/singer`。修改预算或探针后重新执行巡检，构建会拒绝旧的、不完整的或政策不一致的报告。

## 查看 Actions 结果

[daily.yml](../.github/workflows/daily.yml) 将离线测试、真实巡检和发布分成不同 job。Pull Request 只跑离线测试；定时、手动和指定代码变更可触发真实巡检。

巡检 job 的仓库权限是只读；发布 job 只复制和提交健康报告、播放报告与整合脚本。`diagnostics` 附件保留 7 天，包含完整 JSON 和中间快照。状态缓存未命中时重新发现上游。

查看失败时先定位步骤，再对应处理：

| 错误或步骤 | 处理 |
|---|---|
| 上游 Download HTTP 403、404 或网络异常 | 核查 GitHub API 认证、额度、上游仓库和网络；部分抓取失败会保留旧快照并停止本轮 |
| OS sandbox preflight failed | 检查 bubblewrap、prlimit 与 Linux 用户命名空间是否可用 |
| 报告过期、runId 或 SHA256 不匹配 | 重新按 fetch、health、build 顺序运行 |
| No healthy sources | 查看各曲目的 L1/L2/L3 明细，不把返回 URL 当成音频成功 |
| Merged playback validation failed | 查看失败的宿主、平台和音质；整合包未满足发布条件 |
| master 在巡检期间前进 | 对最新代码重新巡检，再发布结果 |

## 更新客户端副本

GitHub 成功发布后，在客户端重新导入首页的 raw 地址。首次导入或显示列表异常时，同时检查宿主的公共源权限；lxserver 的 `enablePublicSources` 和用户权限说明见[集成指南](../integrations/lxserver/README.md)。

返回[文档索引](index.md)。
