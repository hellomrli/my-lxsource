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
| L3 | 真是音频（content-type + 文件魔数） | 返回的是错误页/JSON |

**只有 L3 通过才计入「可用」。**

## 跟踪的上游仓库

| key | 仓库 | 说明 |
|---|---|---|
| `pdone` | [pdone/lx-music-source](https://github.com/pdone/lx-music-source) | 洛雪音乐源（最常见） |
| `lxs` | [hwxlikemi/lxs](https://github.com/hwxlikemi/lxs) | 13 个精选音源，**当前最优源（念心）来自这里** |
| `xinghai` | [cdyUuu/lx-music-xinghai-source](https://github.com/cdyUuu/lx-music-xinghai-source) | 星海音乐源 |
| `sixyin-cc` | [cc2415/lx-custom-music-source](https://github.com/cc2415/lx-custom-music-source) | 六音 |

## 每日流程

```
fetch-upstream  拉取上游 latest.js, 与 state.json 比对 SHA256 → 得出变更
     ↓
test-sources    对每个 源×平台: L1(取URL) → L2(连通) → L3(音频校验)
     ↓
build           从「L3 通过」的源中挑选，生成单一整合音源脚本
     ↓
report          输出 reports/health.json + reports/health.md，提交回仓库
```

## 目录

```
.github/workflows/daily.yml   每日定时任务
scripts/fetch-upstream.mjs    上游抓取与变更检测
scripts/test-sources.mjs      三层可用性检测
scripts/build-source.mjs      生成整合音源脚本
templates/merged-source.js    整合音源模板（LX 自定义源格式）
state.json                    上次巡检快照（SHA256 + 时间）
reports/                      巡检报告
dist/merged-source.js         生成的整合音源（供客户端导入）
```

## 整合音源的原理

洛雪自定义源脚本**只负责 `musicUrl`（把 songmid 换成播放地址），搜索由客户端 SDK 完成**。
所以「整合」= 把多个 L3 通过的上游脚本内联进一个自包含脚本：每个子源在独立的
`lx` shim 下加载并收集 handler，请求时按优先级依次调用，返回第一个有效地址。

见 `templates/merged-source.js`。

## 用法

1. 在 Actions 里手动跑一次，或等每日定时
2. 看 `reports/health.md` 了解各源状态
3. 客户端导入 `dist/merged-source.js` 的 raw 地址：

   `https://raw.githubusercontent.com/hellomrli/my-lxsource/master/dist/merged-source.js`

## 安全说明

- 仓库公开，产物不含任何服务器凭据
- 音源脚本在 Worker 沙箱中隔离执行（`lx-user-api-env`）
- 不保存任何第三方凭据
