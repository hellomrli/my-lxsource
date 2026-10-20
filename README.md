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
| L2 | URL 连通性（HTTP 200/206/302 跟随后 200） | 后端接口下线 |
| L3 | 音频魔数校验（另记录 content-type） | 返回的是错误页/JSON |

**只有 L3 通过才计入「可用」。**

## 跟踪的上游仓库

| key | 仓库 | 说明 |
|---|---|---|
| `pdone` | [pdone/lx-music-source](https://github.com/pdone/lx-music-source) | 洛雪音乐源（最常见） |
| `lxs` | [hwxlikemi/lxs](https://github.com/hwxlikemi/lxs) | 收集的精选音源，以最新巡检报告为准 |
| `xinghai` | [cdyUuu/lx-music-xinghai-source](https://github.com/cdyUuu/lx-music-xinghai-source) | 星海音乐源 |
| `sixyin-cc` | [cc2415/lx-custom-music-source](https://github.com/cc2415/lx-custom-music-source) | 六音 |

## 每日流程

```
fetch-upstream  拉取上游脚本，与 state.json 比对 SHA256 → 得出变更
     ↓
test-sources    对每个 源×平台: L1(取URL) → L2(连通) → L3(音频校验)
     ↓
build           从「L3 通过」的源中挑选，生成单一整合音源脚本
     ↓
publish         仅提交 reports/health.md + dist/merged-source.js
```

## 目录

```
.github/workflows/daily.yml   每日定时任务
scripts/fetch-upstream.mjs    上游抓取与变更检测
scripts/test-sources.mjs      三层可用性检测
scripts/build-source.mjs     生成整合音源脚本
scripts/lx-runtime.mjs       无头 LX API 兼容运行时
templates/merged-source.js   整合音源模板（LX 自定义源格式）
config.json                 项目配置（直接修改此文件）
reports/health.md            最新可读巡检报告
dist/merged-source.js        生成的整合音源（供客户端导入）
```

`state.json` 与 `reports/health.json` 是运行时生成的中间数据，不再提交到 Git。
Actions 用缓存保存上次巡检快照，并用保留 7 天的 `diagnostics` 附件保存完整报告；
缓存未命中时会重新发现全部音源，不影响检测和构建。

巡检与发布在两个独立的 Actions job 中运行：巡检只有仓库读取权限，
发布 job 只复制并提交指定产物，不执行音源脚本。
巡检或构建失败时，工作流会失败，仓库里的上一个成功产物保持不变。
若 `master` 在巡检期间发生更新，发布会停止，避免旧结果覆盖新代码。

## 整合音源的原理

洛雪自定义源脚本**只负责 `musicUrl`（把 songmid 换成播放地址），搜索由客户端 SDK 完成**。
所以「整合」= 把多个 L3 通过的上游脚本内联进一个自包含脚本：每个子源在独立的
`lx` shim 下加载并收集 handler，请求时按优先级依次调用，返回第一个有效地址。

见 `templates/merged-source.js`。

当前整合脚本只验证子源返回的是 HTTP(S) URL，播放时不会重新做 L2/L3 检查；
巡检通过不代表所有曲目、音质或未检测的平台都可用。

## 用法

1. 在 Actions 里手动跑一次，或等每日定时
2. 看 `reports/health.md` 了解各源状态
3. 客户端导入 `dist/merged-source.js` 的 raw 地址：

   `https://raw.githubusercontent.com/hellomrli/my-lxsource/master/dist/merged-source.js`

## 本地运行

需要 Node.js 20 或更新版本，没有第三方 npm 依赖。

```sh
npm run all
```

也可以按 `npm run fetch` → `npm test` → `npm run build` 的顺序执行。
`npm test` 是需要联网并执行上游代码的健康巡检，不是离线单元测试。
首次运行必须先抓取、再巡检，不能只依赖仓库中保留的可读报告构建。

## 安全说明

- 仓库公开，产物不含任何服务器凭据
- 本地运行时使用 `node:vm` 模拟 LX API，**不是安全沙箱，也没有使用 Worker 或 `lx-user-api-env`**
- 上游脚本属于不可信代码；不要在带有 GitHub 登录、SSH 密钥、服务器凭据或其他私密数据的本机直接巡检，应使用无敏感信息的隔离环境
- `state.json` 只记录上游元数据；完整健康报告可能包含临时播放 URL，应避免长期公开保存
- 生成脚本不依赖自建 lxserver 代理，但各子源仍会访问自己的上游 API
