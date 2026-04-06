# Crawler 设计方案

## 状态：设计阶段，未开始开发

## 核心思路

在 anyreach 现有架构上新增爬虫编排层，采用**双模式架构**：

```
scripts/cdp-proxy.mjs      ← 不动，纯基础设施
scripts/adapter-runner.mjs  ← 不动，纯提取逻辑
scripts/crawler.mjs         ← 新增，爬虫编排层
lib/browser-provider.mjs    ← 新增，浏览器实例管理（双模式抽象）
```

## 设计原则

- **复用不侵入**：crawler 通过 CDP Proxy 的 HTTP API 操作浏览器，不直接耦合 proxy 内部实现
- **adapter 天然复用**：爬虫访问有 adapter 的站点时自动走 adapter 提取路径
- **双模式隔离**：interactive 和 crawler 使用不同的浏览器实例，互不干扰
- **agent 模式零影响**：现有交互式单页操作逻辑完全不变

---

## 双模式架构

### User Mode（interactive）

现有模式，不变。附着用户日常 Chrome，复用登录态，在后台 tab 操作。
适用于：agent 驱动的单页交互、需要用户实时浏览器环境的场景。

### Managed Mode（crawler 默认）

Crawler 启动独立 Chrome 实例，使用独立 `userDataDir` 和独立调试端口。

优势：
- 和用户浏览器完全隔离，不会污染用户 tab、cookie、历史状态
- 生命周期更清晰，job 启动时拉起浏览器，结束时整体回收，崩了直接重启
- 并发控制更直接，tab 数、浏览器实例数、资源预算都能由 crawler 自己掌控
- 调试和复现更稳定，同一个 job 的环境更接近"可重跑"

约束：
- 独立进程默认拿不到用户登录态 → 通过 cookie 移植解决（见下节）
- 反爬和指纹问题会更明显 → 后续迭代考虑指纹伪装
- adapter/hint/none 分层保持不变，不因为独立进程就退化成只会 extractText

### Browser Provider 抽象

不过度设计，一个 factory function 即可：

```js
// lib/browser-provider.mjs
// createBrowser - 根据 mode 创建浏览器实例
// 返回 { wsEndpoint, cdpPort, close() }
async function createBrowser(opts) {
  // opts.mode: 'user' | 'managed'
  // opts.userDataDir: managed mode 下的 profile 目录（可选）
  // opts.port: 调试端口（managed mode 自动分配）
  // opts.headless: 是否无头模式（默认 true）
}
```

User mode：发现现有 Chrome 调试端口并附着（现有 cdp-proxy 逻辑）。
Managed mode：`child_process.spawn` 启动 Chrome，传入 `--remote-debugging-port` 和 `--user-data-dir`。

两种模式返回相同接口，上层 crawler 和 adapter 不感知差异。

---

## Cookie 移植（Managed Mode 登录态方案）

独立 Chrome 进程默认没有用户登录态，通过 CDP 接口从用户 Chrome 移植。

### 流程

```
Crawler 启动
  → 连接用户 Chrome（通过现有 CDP Proxy）
  → Network.getAllCookies() 导出所有 cookie
  → 启动 managed Chrome 实例
  → Network.setCookies() 注入 cookie
  → 断开与用户 Chrome 的连接
  → 开始爬取
```

### 覆盖层级

| 层级 | 覆盖率 | 实现难度 | 优先级 |
|------|--------|---------|--------|
| Cookie 移植 | ~95% 站点 | 低，几行 CDP 调用 | P0，首版实现 |
| + localStorage 移植 | ~99% | 中，需按域名逐个导航注入 | P1，按需追加 |
| + indexedDB / ServiceWorker | ~100% | 高 | P2，几乎无站点仅靠这些做 auth |

### localStorage 移植方案（P1）

针对目标域名列表：
1. 在用户 Chrome 中导航到该域名，`Runtime.evaluate` 读出 `localStorage` 全量数据
2. 在 managed Chrome 中导航到该域名，`Runtime.evaluate` 写入数据

### 隔离优势

Cookie 是启动时快照式复制。Crawler 运行过程中不管怎么折腾（清 cookie、被踢登录、浏览器崩溃）都不会影响用户日常 Chrome 的登录态。这是 managed mode 相比 user mode 的核心安全收益。

---

## crawler.mjs 职责

| 模块 | 说明 |
|------|------|
| URL 队列 | 从文件/stdin/参数读入待爬 URL 列表 |
| 并发池 | 控制同时打开的 tab 数量（默认 3-5） |
| 节流 | 请求间隔、每域名限速 |
| 操作等待 | 点击后等待时间、waitFor 超时，均可配置 |
| 重试与跳过 | 失败 N 次后跳过，记录失败 URL |
| 进程重启 | 跑完 N 个 URL 后重启 Chrome 进程，释放内存泄漏 |
| 输出 | NDJSON 到 stdout，每行一个结果 |

### 浏览器进程粒度

**每个 crawl job 一个浏览器进程**（不是每个 URL 一个）。每个 URL 起一个进程会导致启动成本、内存占用、登录成本都变得很差。

如果 job 跑的 URL 很多，通过 `--restart-after <n>` 控制进程存活周期，避免长时间运行的内存泄漏问题。

---

## 参数设计

```
# 基础参数
--urls <file>              URL 列表文件，每行一个
--concurrency <n>          并发 tab 数，默认 3
--delay <ms>               每次请求间隔，默认 1000
--timeout <ms>             单页超时，默认 30000
--retry <n>                失败重试次数，默认 2
--wait-after-click <ms>    点击操作后等待时间，默认 2000
--output <file>            输出文件，默认 stdout

# 浏览器模式
--mode <user|managed>      浏览器模式，默认 managed
--headless                 无头模式（仅 managed mode），默认 true
--user-data-dir <path>     Chrome profile 目录（仅 managed mode）
--restart-after <n>        每跑完 n 个 URL 重启 Chrome 进程，默认不重启

# Cookie 移植
--copy-cookies             从用户 Chrome 移植 cookie（仅 managed mode），默认 true
--copy-localstorage        移植 localStorage（仅 managed mode），默认 false
```

---

## 数据流

### Managed Mode（默认）

```
启动 → 连接用户 Chrome → 导出 cookie
     → 启动 managed Chrome → 注入 cookie
     → URL 队列 → 并发池调度 → 打开 tab
                              → adapter check → 有 adapter? → run 提取
                                              → 无 adapter? → 通用提取
                              → 收集结果 → NDJSON 输出
                              → 关闭 tab
     → 全部完成 → 关闭 managed Chrome
```

### User Mode

```
启动 → 附着用户 Chrome（通过 CDP Proxy）
     → URL 队列 → 并发池调度 → /new 打开 tab
                              → adapter check → 有 adapter? → run 提取
                                              → 无 adapter? → 通用提取
                              → 收集结果 → NDJSON 输出
                              → /close 关闭 tab
```

---

## 注意事项

- User mode 使用用户日常 Chrome，并发过高会卡浏览器，默认保守
- Managed mode 默认无头，不占用用户屏幕
- 断点续爬、进度持久化作为后续迭代方向
- 反爬指纹伪装作为后续迭代方向
