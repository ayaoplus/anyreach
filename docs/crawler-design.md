# Crawler 设计方案

## 核心思路

在 anyreach 现有架构上新增爬虫编排层，不修改现有代码。

```
scripts/cdp-proxy.mjs      ← 不动，纯基础设施
scripts/adapter-runner.mjs  ← 不动，纯提取逻辑
scripts/crawler.mjs         ← 新增，爬虫编排层
```

## 设计原则

- **复用不侵入**：crawler 通过 CDP Proxy 的 HTTP API 操作浏览器，不直接耦合 proxy 内部实现
- **adapter 天然复用**：爬虫访问有 adapter 的站点时自动走 adapter 提取路径
- **agent 模式零影响**：现有交互式单页操作逻辑完全不变

## crawler.mjs 职责

| 模块 | 说明 |
|------|------|
| URL 队列 | 从文件/stdin/参数读入待爬 URL 列表 |
| 并发池 | 控制同时打开的 tab 数量（默认 3-5） |
| 节流 | 请求间隔、每域名限速 |
| 操作等待 | 点击后等待时间、waitFor 超时，均可配置 |
| 重试与跳过 | 失败 N 次后跳过，记录失败 URL |
| 输出 | NDJSON 到 stdout，每行一个结果 |

## 参数设计（初步）

```
--urls <file>          URL 列表文件，每行一个
--concurrency <n>      并发数，默认 3
--delay <ms>           每次请求间隔，默认 1000
--timeout <ms>         单页超时，默认 30000
--retry <n>            失败重试次数，默认 2
--wait-after-click <ms>  点击操作后等待时间，默认 2000
--output <file>        输出文件，默认 stdout
```

## 数据流

```
URL 列表 → 并发池调度 → CDP Proxy /new 打开 tab
                       → adapter-runner check → 有 adapter? → run 提取
                                              → 无 adapter? → 通用提取（extractText）
                       → 收集结果 → NDJSON 输出
                       → /close 关闭 tab
```

## 注意事项

- 使用用户日常 Chrome，并发过高会卡浏览器，默认保守
- 后续可考虑支持启动独立 headless Chrome 实例专跑爬虫
- 断点续爬、进度持久化作为后续迭代方向

## 状态

**设计阶段** — 等 bug 修完后开始实现。
