# AnyReach 架构文档

> English version: [architecture.md](architecture.md)

## 设计哲学

大多数 AI Agent 浏览器工具把每次访问当作一张白纸——LLM 从零写 JS、探索 DOM、处理虚拟化渲染。Token 在燃烧，结果不稳定。

AnyReach 采用不同的思路：通过 CDP 连接用户日常 Chrome（共享登录态、后台 tab 操作），在此基础上叠加 **站点适配器**（可执行的提取代码）、**提示词**（面向 LLM 的站点知识）、**远程注册表**（按需下载）、**批量爬虫**（并发多 URL 提取）。

## 系统总览

<img src="images/architecture-overview-zh.png" alt="架构总览" width="700" />

### 四层架构

| 层级 | 组件 | 职责 |
|------|------|------|
| 策略 | SKILL.md | 教 Agent *怎么思考*网页任务。工具选择、浏览哲学、失败处理。不含站点特定逻辑。 |
| 基础设施 | CDP Proxy | 通用 HTTP 浏览器自动化。24+ 端点，零站点特定代码。能 `curl` 就能用。 |
| 知识 | 适配器 + 提示词 | 按域名的提取逻辑。代码适配器（`.mjs`）确定性提取，提示词（`.md`）LLM 引导式探索。 |
| 分发 | 远程注册表 | `registry.json` 索引适配器，Runner 首次使用时自动下载。 |

### 请求流程

<img src="images/request-flow-zh.png" alt="请求流程" width="380" />

解析顺序：本地适配器 → 本地提示词 → 远程注册表（自动下载）→ 通用 CDP 模式。登录墙检测在适配器执行前运行。Tab 在 `finally` 中始终关闭。

## 文件结构

```
scripts/
  cdp-proxy.mjs           HTTP 服务器，curl → Chrome DevTools Protocol 桥接
  adapter-runner.mjs       适配器调度：URL 匹配 → 运行适配器 → 返回 JSON
  crawler.mjs              批量 URL 提取，并发、重试、NDJSON 输出
  collect-urls.mjs         从列表抓取结果中提取内容 URL
  check-deps.mjs           环境检查 + Proxy 自动启动
  install.mjs              Skill 符号链接安装器

lib/
  proxy-client.mjs         ProxyClient 类（CDP Proxy 的共享 HTTP 客户端）
  login-detector.mjs       通用登录墙检测（二维码/账密/未知类型）
  browser-provider.mjs     浏览器实例工厂（user 模式 / managed 模式）

adapters/
  feishu.mjs               详见 adapter-feishu.md
  scys.mjs                 详见 adapter-scys.md
  x.mjs                    详见 adapter-x.md
  xiaohongshu.mjs
  _utils.mjs               共享工具：sleep, scrollToLoad, downloadMedia
  _template.mjs            新适配器模板
```

## CDP Proxy

Node.js HTTP 服务器，运行于 `localhost:3456`。持久化后台进程——修改代码后重启：`pkill -f cdp-proxy.mjs && node scripts/check-deps.mjs`。

### 连接流程

```
check-deps.mjs
  ├── 检查 Node.js >= 22
  ├── 发现 Chrome 调试端口
  │     ├── 读取 DevToolsActivePort 文件
  │     └── 回退：探测端口 9222, 9229, 9333
  └── 启动 cdp-proxy.mjs（后台进程）
        ├── WebSocket 连接 Chrome
        ├── 监听 localhost:3456
        └── 就绪
```

### 反检测

页面可通过探测调试端口检测自动化。Proxy 通过 `Fetch.requestPaused` 拦截并返回 `ConnectionRefused`。

### 会话模型

每个 tab 用 `targetId` 标识。Proxy 维护 `targetId → sessionId` 映射。会话懒创建，关闭时清理。多个 Agent 共享一个 Proxy——各用各的 targetId，无竞争。

### 端点参考

#### Tab 管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 连接状态 |
| `/targets` | GET | 列出所有 tab |
| `/new?url=` | GET | 创建后台 tab |
| `/close?target=` | GET | 关闭 tab |

#### 导航与交互

| 端点 | 方法 | Body | 说明 |
|------|------|------|------|
| `/navigate?target=&url=` | GET | — | 导航到 URL |
| `/eval?target=` | POST | JS | 执行 JavaScript（支持 async） |
| `/click?target=` | POST | CSS 选择器 | `el.click()` |
| `/clickAt?target=` | POST | CSS 选择器 | 真实鼠标事件 |
| `/fill?target=` | POST | `{selector, value}` | 填写表单，触发 React/Vue 响应式 |
| `/scroll?target=&direction=` | GET | — | 滚动，等待懒加载 |

#### 内容提取

| 端点 | 方法 | Body | 说明 |
|------|------|------|------|
| `/extractText?target=` | POST | `{selector, scroll}` | 自动滚动 + DOM 文本提取 |
| `/screenshot?target=&file=` | GET | — | 截图 |
| `/waitFor?target=&selector=` | GET | — | 等待元素出现 |

#### Cookie、脚本注入、CDP 透传

| 端点 | 方法 | Body | 说明 |
|------|------|------|------|
| `/setCookie?target=` | POST | Cookie JSON | 注入 Cookie |
| `/getCookies?target=&domain=` | GET | — | 获取 Cookie |
| `/preScript?target=` | POST | JS | 页面 JS 执行前注入脚本 |
| `/cdp?target=` | POST | `{method, params}` | 任意 CDP 命令 |
| `/adapter?url=` | POST | — | 运行适配器。返回内容、401 `login_required` 或 404 `no_adapter` |

## 站点适配器系统

### 适配器接口

```javascript
export default {
  name: 'example',
  domains: ['example.com'],
  detect(url) { ... },                        // → 页面类型字符串
  async extract(proxy, targetId, ctx) { ... }, // → 结构化结果
};
```

`proxy` 是 `ProxyClient` 实例，封装 CDP Proxy HTTP 调用。`ctx` 含 `{ url, pageType, ...opts }`。

### Adapter Runner

```bash
node scripts/adapter-runner.mjs list                          # 列出适配器
node scripts/adapter-runner.mjs run <url> [--ctx <json>]      # 运行适配器
node scripts/adapter-runner.mjs retry-after-login <id> <url>  # 登录后重试
node scripts/adapter-runner.mjs check <url>                   # 检查匹配层级
```

`--ctx` 参数传递适配器配置：`limit`、`maxPages`、`mode`、`checkpointFile`、`resumePage` 等。

### 远程注册表

`registry.json` 索引可用适配器。找不到本地匹配时，从 GitHub 下载适配器文件 + 共享依赖。

### 已安装适配器

| 适配器 | 域名 | 详情 |
|--------|------|------|
| feishu | feishu.cn, larksuite.com | [adapter-feishu.md](adapter-feishu.md) |
| scys | scys.com | [adapter-scys.md](adapter-scys.md) |
| x | x.com, twitter.com | [adapter-x.md](adapter-x.md) |
| xiaohongshu | xiaohongshu.com | 笔记、主页、信息流 |

## 登录墙检测

`lib/login-detector.mjs` 提供全站点通用的登录墙检测。

**检测逻辑**：先检查内容选择器（已登录 → 返回 null），再在 modal/dialog/overlay 容器中扫描登录文字。仅当页面主体内容极短（< 200 字符）时才信任全页文字检测，避免正文误判。

**三个方法**：
- `detect()` → `null | { type: 'qr' | 'form' | 'unknown' }`
- `capture()` → `{ type, screenshotPath?, fields?, message }`
- `waitForLogin()` → 轮询直到登录墙消失（3 分钟超时）

**与 runAdapter 集成**：检测到登录墙时 throw `LOGIN_REQUIRED`（tab 在 `finally` 中始终关闭，无泄漏）。CLI `run` 命令截获后截图二维码、开新 tab、输出 retry 命令（保留原始 `--ctx`）。crawler 记录为 error，不重试。

## 批量爬取

### 设计原则

爬虫是**纯执行器**——不做决策。爬取策略（哪些 URL、多少页、并发多少）由 Agent 或用户决定。爬虫管理并发、重试、超时和输出。

### 双模式架构

| 模式 | 场景 | 方式 |
|------|------|------|
| **User**（`--mode user`） | 需要登录的站点 | 直连用户 Chrome，天然有登录态 |
| **Managed**（默认） | 公开数据、批量任务 | 独立 headless Chrome + CDP Proxy，隔离环境 |

`lib/browser-provider.mjs` 提供 `createBrowser(opts)` 返回 `{ proxyBase, proxyPort, close() }`，两种模式接口相同。

**Managed 模式限制**：Chrome 路径发现目前仅支持 macOS。

### Cookie 移植（managed 模式）

独立 Chrome 没有登录态。通过 CDP 从用户 Chrome 快照式移植：

```
启动 managed Chrome
  → 用户 Chrome: Network.getAllCookies() 导出全量 cookie
  → Managed Chrome: 逐个 Network.setCookie() 注入
  → 开始爬取
```

`--copy-cookies auto`（默认）：有用户 Chrome 就复制，没有就跳过。Cookie 是启动快照——爬虫运行不会影响用户 Chrome 登录态。

### 并发与超时

`--concurrency N` 是并发 worker 数，不是 tab 数。`--timeout` 是调度层超时，不取消 `runAdapter()`（V2 计划加 AbortSignal）。

### 结果校验

爬虫检查 `result.error` 字段。适配器内部返回 `{ error: '...' }` 的结果记为 error，不计入成功。

### 用法

```bash
node scripts/crawler.mjs --urls urls.txt \
  [--concurrency 3] [--delay 1000] [--timeout 30000] [--retry 2] \
  [--mode managed] [--copy-cookies auto] [--output results.ndjson]
```

## 列表爬取管线

用于分页列表站点（如生财有术精华帖），三步管线：列表抓取 → URL 提取 → 内容爬取。

<img src="images/essence-pipeline-zh.png" alt="爬取管线" width="700" />

```bash
# 第一步：列表抓取（分页 + 断点续传）
node scripts/adapter-runner.mjs run "https://scys.com/?filter=essence" \
  --ctx '{"maxPages":999,"limit":9999,"checkpointFile":"/tmp/cp.json"}'

# 第二步：提取内容 URL（articleDetail + 飞书链接）
node scripts/collect-urls.mjs --input result.json --output urls.txt

# 第三步：批量内容提取
node scripts/crawler.mjs --urls urls.txt --mode user --output full.ndjson
```

## SKILL.md 设计

面向 Agent 的 prompt，教策略不教流程：

1. **浏览哲学** — 四步循环：定义成功 → 选择入口 → 校验 → 确认
2. **工具选择** — WebSearch / Jina / curl / CDP 决策矩阵
3. **CDP Proxy API** — 端点参考
4. **站点知识** — 四层解析：适配器 → 提示词 → 远程 → 通用
5. **登录流程** — LOGIN_REQUIRED 错误结构、二维码截图、retry-after-login
6. **批量爬取** — 爬虫参数、collect-urls、管线示例
7. **站点专项** — scys.com 页面类型、内容类型、全量爬取流程

## 关键设计决策

| 决策 | 理由 |
|------|------|
| **CDP Proxy 而非 Playwright** | 直连 Chrome 保留登录态，避免检测，支持并行后台 tab |
| **适配器模式** | 站点特定代码是可执行知识。有适配器时跳过 LLM 驱动的 DOM 探索 |
| **飞书用 window.DATA** | DOM/innerText/Selection API 因 canvas 级虚拟化渲染全部失效。`window.DATA.clientVars.data.block_map` 是唯一可靠路径 |
| **scys 用 Pinia store** | DOM 卡片无 `<a>` 链接到 articleDetail（Vue Router @click）。`sessionPostStore.postList` 提供 entityType + entityId 构造 URL |
| **throw LOGIN_REQUIRED** | 确保 tab 在 `finally` 中始终关闭。CLI 截获处理交互，批量调用方得到干净错误 |
| **登录检测限定 modal/dialog** | 全页文字扫描会误判正文中的"请登录"。只扫描 modal 容器 + 短页面回退 |
| **原子 checkpoint 写入** | 写 `.tmp` 再 `renameSync`，进程崩溃不损坏断点文件 |

## 已知限制

- **Managed 模式仅 macOS** — Chrome 路径发现只搜索 macOS 路径
- **超时是调度层** — runAdapter 不能中途取消，adapter 的 finally 最终清理
- **Cookie 移植范围** — 覆盖 HTTP cookie（~95% 站点）。微信 OAuth 等可能不适用——用 user 模式
- **爬虫无 URL 去重** — V2 计划。目前依赖输入 URL 列表预去重

## 未来规划

| 项目 | 优先级 | 说明 |
|------|--------|------|
| AbortSignal 支持 | V2 | runAdapter + ProxyClient 执行层取消 |
| 爬虫断点续爬 | V2 | state file 记录进度（目前只有列表适配器有此能力） |
| URL 去重 + 过滤 | V2 | `--dedupe-by url`、`--include/exclude-pattern` |
| Chrome 进程重启 | V2 | `--restart-after N` 防止长爬内存泄漏 |
| 多 Agent 会话 | V3 | `/session/create` + `/session/close`，orphan tab 清理 |
| Agent 驱动 crawl plan | V3 | 自然语言生成结构化爬取计划，多阶段 discover → extract |
