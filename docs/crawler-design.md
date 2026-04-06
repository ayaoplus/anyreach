# Crawler 设计方案

## 状态：设计阶段，未开始开发

## 核心思路

Crawler 不是一个 CLI 工具，而是 **anyreach agent 能力的自然延伸**。

用户只说"要什么"，不说"怎么爬"。Agent 理解意图、生成 crawl plan、调用底层能力执行。

```
用户自然语言描述任务
        ↓
  Skill 层（SKILL.md）         ← 理解意图，生成 crawl plan
        ↓
  Crawler 编排层（crawler.mjs） ← 纯执行器，管并发/重试/输出
        ↓
  底层能力（CDP Proxy + Adapter）← 打开页面、提取内容、处理交互
```

### 文件结构

```
scripts/cdp-proxy.mjs      ← 不动，纯基础设施
scripts/adapter-runner.mjs  ← 不动，纯提取逻辑
scripts/crawler.mjs         ← 新增，crawl plan 执行器
lib/browser-provider.mjs    ← 新增，浏览器实例管理（双模式抽象）
```

## 设计原则

- **Agent 驱动**：所有爬取决策（分几阶段、怎么翻页、并发多少）由 agent 层完成，crawler 只管执行
- **复用不侵入**：crawler 通过 CDP Proxy 的 HTTP API 操作浏览器，不直接耦合 proxy 内部实现
- **adapter 天然复用**：爬虫访问有 adapter 的站点时自动走 adapter 完整分流（adapter → hint → remote → none）
- **双模式隔离**：interactive 和 crawler 使用不同的浏览器实例，互不干扰
- **现有能力零影响**：现有交互式单页操作逻辑完全不变

---

## Agent 驱动的 Crawl Plan

### 用户交互流程

```
用户："爬小红书'露营'话题下前 100 篇笔记"
        ↓
  Agent 分析意图，生成 crawl plan
        ↓
  展示 plan 给用户确认（默认行为）
        ↓
  用户确认 / 调整 → 执行
```

默认先展示 plan 再执行，因为爬虫是批量操作，跑错了浪费时间。
用户说"直接跑"则跳过确认。

### Crawl Plan 结构

Agent 生成结构化 plan，crawler.mjs 负责执行：

```json
{
  "task": "爬小红书露营话题前100篇笔记",
  "steps": [
    {
      "phase": "discover",
      "description": "从搜索结果中收集笔记链接",
      "action": "search_and_collect",
      "params": { "keyword": "露营", "platform": "xiaohongshu" },
      "expect": "url_list",
      "limit": 100
    },
    {
      "phase": "extract",
      "description": "批量提取笔记内容",
      "action": "batch_extract",
      "input": "previous.url_list",
      "adapter": "auto"
    }
  ],
  "config": {
    "mode": "managed",
    "copy_cookies": "auto",
    "concurrency": 3,
    "delay": "2000-5000",
    "retry": 2,
    "output": "ndjson"
  }
}
```

### Agent 自动决策的维度

| 决策 | 说明 |
|------|------|
| 是否分阶段 | 有列表页 → 详情页结构就分 discover + extract 两阶段 |
| discover 策略 | 搜索、滚动加载、翻页、调 API — 由 agent 根据站点特性判断 |
| 并发策略 | 反爬严格的站点保守（2-3），公开数据站点可激进（5-10） |
| 是否需要登录态 | 需要就自动启用 cookie 移植 |
| delay 范围 | 根据站点风控特点自动设置合理区间 |
| 输出字段 | 根据任务目的选择输出哪些字段 |

高级用户可以用自然语言 override 任何默认决策：
> "帮我爬这些 URL，并发 10，不要限速"
> → agent 理解为用户知道自己在干嘛，覆盖默认保守配置

### 多级爬取逻辑

本质上是 plan 里的多个 step，前一个 step 的输出是后一个 step 的输入。

典型的两阶段模式：

**阶段 1 - Discover**：用 agent 能力（搜索、滚动、翻页）从列表页/搜索结果中收集 URL。
这个阶段本质上是 **agent 任务**，需要理解页面结构、处理各种翻页逻辑，适合用现有的 agent + adapter 能力完成。

**阶段 2 - Extract**：用 crawler 批量爬取阶段 1 收集到的 URL 列表。
这个阶段是**批处理任务**，crawler.mjs 的核心能力。

两阶段之间，URL 列表作为中间产物可以被审查、过滤、去重后再进入下一阶段。

---

## 双模式架构

### User Mode（interactive）

现有模式，不变。附着用户日常 Chrome，复用登录态，在后台 tab 操作。
适用于：agent 驱动的单页交互、需要用户实时浏览器环境的场景、discover 阶段。

### Managed Mode（crawler 默认）

Crawler 启动独立 Chrome 实例，使用独立 `userDataDir` 和独立调试端口。

优势：
- 和用户浏览器完全隔离，不会污染用户 tab、cookie、历史状态
- 生命周期更清晰，job 启动时拉起浏览器，结束时整体回收，崩了直接重启
- 并发控制更直接，资源预算由 crawler 自己掌控
- 调试和复现更稳定，同一个 job 的环境更接近"可重跑"

约束：
- 独立进程默认拿不到用户登录态 → 通过 cookie 移植解决（见下节）
- 反爬和指纹问题会更明显 → 后续迭代考虑指纹伪装
- adapter/hint/remote/none 完整分流保持不变，不因为独立进程就退化

### Browser Provider 抽象

不过度设计，一个 factory function 即可：

```js
// lib/browser-provider.mjs
// createBrowser - 根据 mode 创建浏览器实例 + 对应 CDP Proxy
// 返回 { proxyBase, proxyPort, close() }
async function createBrowser(opts) {
  // opts.mode: 'user' | 'managed'
  // opts.userDataDir: managed mode 下的 profile 目录（可选）
  // opts.headless: 是否无头模式（默认 true）
}
```

关键：返回 `proxyBase/proxyPort` 而不是 `wsEndpoint`，因为上层（adapter-runner、crawler）全部通过 HTTP Proxy API 工作。

- User mode：发现现有 Chrome 调试端口，启动 CDP Proxy 附着。
- Managed mode：`child_process.spawn` 启动 Chrome + CDP Proxy，传入独立调试端口和 `userDataDir`。

两种模式返回相同接口，上层不感知差异。

---

## Cookie 移植（Managed Mode 登录态方案）

独立 Chrome 进程默认没有用户登录态。通过 CDP 接口从用户 Chrome 串行移植。

### 流程

```
Crawler 启动
  → 连接用户 Chrome（通过现有 CDP Proxy）
  → Network.getAllCookies() 导出所有 cookie
  → 断开与用户 Chrome 的连接
  → 启动 managed Chrome 实例
  → Network.setCookies() 注入 cookie
  → 开始爬取
```

注意：是**串行**的，先导出再注入，不需要同时连接两个 Chrome。

### --copy-cookies 默认值：auto

- `auto`（默认）：检测到用户 Chrome 在跑就复制 cookie，没有就跳过
- `true`：强制复制，用户 Chrome 没跑则报错
- `false`：不复制，使用干净的浏览器环境

默认 `auto` 而不是 `true`，避免 managed mode 强依赖用户 Chrome 在线，保持"隔离模式"的独立性。

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

## crawler.mjs — 纯执行器

crawler.mjs 不做任何"决策"，只负责可靠地执行 crawl plan。

| 模块 | 说明 |
|------|------|
| Plan 执行 | 按 step 顺序执行 crawl plan，前一步输出作为后一步输入 |
| 并发池 | 控制同时运行的 worker 数量（默认 3） |
| 节流 | 请求间隔、每域名限速 |
| 重试与跳过 | 失败 N 次后跳过，记录失败 URL |
| 去重 | URL 去重（默认）/ 内容哈希去重（可选） |
| 进度与恢复 | state file 记录进度，支持断点续爬 |
| 进程重启 | 跑完 N 个 URL 后重启 Chrome 进程，释放内存 |
| 输出 | NDJSON 到 stdout，每行一个结果 |

### 并发语义

`--concurrency` 指的是**并发 worker 数**（同时处理的 URL 数），不是 tab 数。
因为单个 adapter 内部可能开子 tab，实际 tab 数可能大于 worker 数。
全局 tab 上限由 browser-provider 层面兜底。

### 浏览器进程粒度

**每个 crawl job 一个浏览器进程**（不是每个 URL 一个）。

如果 job 跑的 URL 很多，通过 `--restart-after <n>` 控制进程存活周期，避免长时间运行的内存泄漏。重启时自动重新注入 cookie。

---

## 参数设计

大部分参数由 agent 自动决定。用户可以用自然语言 override，也可以直接传 CLI 参数。

```
# 基础参数
--urls <file>              URL 列表文件，每行一个
--concurrency <n>          并发 worker 数，默认 3
--delay <ms>               每次请求间隔，默认 1000
--timeout <ms>             单页超时，默认 30000
--retry <n>                失败重试次数，默认 2
--output <file>            输出文件，默认 stdout

# 浏览器模式
--mode <user|managed>      浏览器模式，默认 managed
--headless                 无头模式（仅 managed mode），默认 true
--user-data-dir <path>     Chrome profile 目录（仅 managed mode）
--restart-after <n>        每跑完 n 个 URL 重启 Chrome 进程，默认不重启

# Cookie 移植
--copy-cookies <auto|true|false>   从用户 Chrome 移植 cookie（仅 managed mode），默认 auto

# 去重与过滤
--dedupe-by <url|content-hash>     去重策略，默认 url
--include-pattern <glob>           只爬匹配的 URL
--exclude-pattern <glob>           跳过匹配的 URL

# 中断恢复
--state-file <path>        状态文件，记录已完成 URL，支持断点续爬
```

---

## 数据流

### Managed Mode（默认）

```
Agent 生成 crawl plan
  → 展示 plan，用户确认
  → 检测用户 Chrome → cookie auto 移植
  → 启动 managed Chrome + CDP Proxy → 注入 cookie
  → 执行 plan steps:
      discover: agent 收集 URL 列表
      extract:  并发池调度 → 调用 adapter-runner（完整 adapter/hint/remote/none 分流）
                           → 收集结果 → NDJSON 输出
  → 全部完成 → 关闭 managed Chrome
```

### User Mode

```
Agent 生成 crawl plan
  → 展示 plan，用户确认
  → 附着用户 Chrome（通过 CDP Proxy）
  → 执行 plan steps（同上，但使用用户浏览器）
  → 完成（不关闭用户浏览器）
```

---

## 迭代计划

### 第一版：能跑

- crawler.mjs 基础框架：接收 URL 列表，并发提取，NDJSON 输出
- managed mode + browser-provider
- cookie auto 移植
- 基础参数（concurrency, delay, timeout, retry）

### 第二版：可靠

- state file 断点续爬
- URL 去重 + include/exclude 过滤
- --restart-after 进程重启
- 失败 URL 汇总报告

### 第三版：智能

- Agent 驱动的 crawl plan 生成
- 多阶段 discover → extract
- 自然语言参数 override
- SKILL.md 爬虫策略扩展

---

## 注意事项

- User mode 使用用户日常 Chrome，并发过高会卡浏览器，默认保守
- Managed mode 默认无头，不占用用户屏幕
- 反爬指纹伪装作为后续迭代方向
- localStorage 移植作为 P1 按需追加
