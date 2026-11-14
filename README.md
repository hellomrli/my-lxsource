# my-lxsource

为 LX Music 每日巡检多个自定义音源，并生成带播放验证与自动回退的自包含整合脚本。

[导入脚本](dist/merged-source.js) · [音源巡检](reports/health.md) · [整合包验收](reports/playback.md) · [维护文档](docs/index.md)

## 导入到客户端

在 LX Music 的自定义音源设置中，导入下面的脚本地址：

```text
https://raw.githubusercontent.com/hellomrli/my-lxsource/master/dist/merged-source.js
```

先查看[巡检报告](reports/health.md)和[播放验收报告](reports/playback.md)的时间及平台覆盖，再选择歌曲和音质。仓库中始终保留最后一次成功发布的产物。

客户端保存的是导入时的本地副本。GitHub 更新后，需要重新导入才能使用新脚本。旧版本出现 `Dynamic code execution is not allowed` 时，删除旧的“我的聚合音源”并重新导入；当前加载器使用静态子源函数。

## 支持哪些播放环境

覆盖网易云、QQ、酷我、酷狗、咪咕，即 `wy/tx/kw/kg/mg`。实际声明的平台和音质来自本轮验证结果。

| 宿主能力 | 提供的音质 | 播放校验 |
|---|---|---|
| 有界字节探针或流式 fetch | 验证通过的 `128k/320k/flac/flac24bit` | 读取音频前缀，检查格式和无损位深 |
| 仅普通 LX 请求与 HEAD | 验证通过的 `128k/320k` | 检查连通性和明确的错误类型 |

HEAD 无法证明音频格式或位深。lxserver 用户可按[集成指南](integrations/lxserver/README.md)安装有界字节探针。

## 巡检与回退

- 每个源、平台、音质使用多首歌曲检查：取得 URL、HTTP 连通、真实音频字节，只有第三层通过才记为可用。
- 播放遇到超时、死链或校验失败时尝试下一子源，并短暂降低失败组合的优先级。
- 整合脚本内嵌验证过的源码，不需要额外音源代理；子源仍访问各自上游 API。
- 构建再次验证整合包在字节和 HEAD 两种宿主下的实际播放结果，失败时保留上次产物。

探针通过率是样本结果，不代表全部曲库可用。细节见[验证规则](docs/verification.md)和[整合脚本原理](docs/architecture.md)。

## 本地运行

需要 Linux、Node.js 26.13.0 或更新版本，以及 `bubblewrap` 和 `prlimit`。当前 CI 使用 `.node-version` 指定的 Node.js 26 系列；没有第三方 npm 依赖。

在 Debian/Ubuntu 上安装沙箱工具，再运行离线回归测试：

```bash
git clone https://github.com/hellomrli/my-lxsource.git
cd my-lxsource
sudo apt-get install bubblewrap util-linux
npm test
```

测试通过后，运行完整的上游抓取、真实巡检和构建：

```bash
npm run all
```

该命令会联网并生成缓存、报告和脚本。配置、独立步骤、发布流程和失败排查见[维护指南](docs/maintenance.md)。

## 上游与反馈

跟踪 [pdone](https://github.com/pdone/lx-music-source)、[lxs](https://github.com/hwxlikemi/lxs)、[星海](https://github.com/cdyUuu/lx-music-xinghai-source)、[六音](https://github.com/cc2415/lx-custom-music-source)、[shellsec](https://github.com/shellsec/lx-music-source)、[1010](https://github.com/Lingeng27/lx-music-1010-source) 和 [younger](https://github.com/younger-lgte1/lx-music-source)。来源、固定 commit 与 SHA256 在抓取阶段记录。

在 [Issues](https://github.com/hellomrli/my-lxsource/issues) 中提供宿主版本、平台、音质、脚本导入时间及脱敏错误信息。仓库目前没有根目录许可证文件，嵌入的上游脚本保留各自来源与元数据。
