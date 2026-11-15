# 整合音源播放验收 2026-11-15T02:03:28.111Z

通过实际整合包的 musicUrl → 子源回退 → 播放校验，再独立 GET 检查音频字节。
bytes 模式使用宿主有界字节探针；head 模式模拟普通受限客户端，仅提供普通音质。
HEAD 本身只检查连通性和明确的错误类型，不能证明音频格式。下表通过数包含验收侧独立的音频字节检查。

产物 SHA256：`d8ce4eb5f013ed1ef9393c4feda8193d40f5f77d6246045b70bf868f563bb261`

| 宿主 | 平台 | 音质 | 通过/曲目数 |
|---|---|---|---|
| bytes | wy | 128k | 2/2 |
| bytes | wy | 320k | 2/2 |
| bytes | wy | flac | 2/2 |
| bytes | wy | flac24bit | 2/2 |
| bytes | tx | 128k | 2/2 |
| bytes | tx | 320k | 2/2 |
| bytes | tx | flac | 2/2 |
| bytes | kw | 128k | 2/2 |
| bytes | kw | 320k | 2/2 |
| bytes | kw | flac | 2/2 |
| bytes | kw | flac24bit | 1/2 |
| bytes | kg | 128k | 2/2 |
| bytes | kg | 320k | 2/2 |
| bytes | kg | flac | 2/2 |
| bytes | kg | flac24bit | 2/2 |
| bytes | mg | 128k | 2/2 |
| bytes | mg | 320k | 2/2 |
| bytes | mg | flac | 2/2 |
| head | wy | 128k | 2/2 |
| head | wy | 320k | 2/2 |
| head | tx | 128k | 1/2 |
| head | tx | 320k | 1/2 |
| head | kw | 128k | 2/2 |
| head | kw | 320k | 2/2 |
| head | kg | 128k | 2/2 |
| head | kg | 320k | 2/2 |
| head | mg | 128k | 2/2 |
| head | mg | 320k | 2/2 |
