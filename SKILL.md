---
name: anyreach
description:
  Agent 联网与浏览器操作 skill。覆盖搜索、网页抓取、登录后操作、浏览器自动化、站点适配器。
  触发场景：搜索信息、查看网页、操作网页界面、抓取社交媒体内容、读取动态渲染页面。
---

# AnyReach

## 前置检查

```bash
node "$(dirname "$0")/scripts/check-deps.mjs"
# 如果上述路径不可用，用 skill 目录的绝对路径替代：
# node /path/to/anyreach/scripts/check-deps.mjs
```

未通过时引导用户：
- **Node.js 22+**（原生 WebSocket）
- **Chrome remote-debugging**：`chrome://inspect/#remote-debugging` → 勾选 Allow

通过后展示：
```
提示：部分站点对自动化操作检测严格，存在账号风险。已内置防护但无法完全避免。
```

## 浏览哲学

**像人一样思考，目标驱动，边看边判断。**

① **定义成功标准** — 什么算完成？拿到什么信息、达到什么结果？后续所有判断的锚点。
② **选择起点** — 按场景选最可能直达的方式。需登录态或反爬平台 → 直接 CDP，不在静态工具上浪费时间。
③ **过程校验** — 每步结果都是证据。搜索没命中可能是目标不存在；页面缺预期元素，该换方向而非反复重试。弹窗/登录墙先判断是否真的挡住了目标——内容可能已在 DOM 中。
④ **完成判断** — 对照成功标准确认，不过度操作。

## 工具选择

| 场景 | 工具 |
|------|------|
| 搜索关键词、发现信息来源 | Agent 内置搜索工具（如有）或 CDP 打开搜索引擎 |
| URL 已知，公开页面提取信息 | Agent 内置网页读取工具（如有），或 **Jina**（`r.jina.ai/example.com`，省 token），或 **curl** |
| 需要原始 HTML（meta、JSON-LD） | **curl** |
| 反爬平台、需登录态、需交互操作 | **CDP Proxy** |

一手信息优于二手信息。搜索引擎是发现入口，不是证明手段。

## CDP Proxy

直连用户日常 Chrome，天然携带登录态。所有操作在后台 tab 中，不干扰用户。

### 启动

```bash
node "<anyreach_dir>/scripts/check-deps.mjs"
```

> `<anyreach_dir>` 是本 skill 所在目录。Agent 可通过环境变量（如 `$CLAUDE_SKILL_DIR`）或安装路径确定。

### API

```bash
# 基础操作
curl -s "http://localhost:3456/new?url=URL"                          # 新建后台 tab
curl -s "http://localhost:3456/info?target=ID"                       # 页面信息
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'JS代码'   # 执行 JS
curl -s -X POST "http://localhost:3456/click?target=ID" -d '选择器'   # JS 点击
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d '选择器' # 真实鼠标点击
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"    # 滚动
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/s.png" # 截图
curl -s "http://localhost:3456/navigate?target=ID&url=URL"           # 导航
curl -s "http://localhost:3456/close?target=ID"                      # 关闭 tab

# 增强操作
curl -s -X POST "http://localhost:3456/extractText?target=ID" \
  -d '{"selector":".content","scroll":true}'                         # 提取可见文本
curl -s -X POST "http://localhost:3456/fill?target=ID" \
  -d '{"selector":"input","value":"text"}'                           # 填写表单
curl -s "http://localhost:3456/waitFor?target=ID&selector=.loaded"   # 等待元素出现
curl -s -X POST "http://localhost:3456/setCookie?target=ID" \
  -d '{"name":"k","value":"v","domain":".x.com","httpOnly":true}'    # 注入 Cookie
curl -s "http://localhost:3456/getCookies?target=ID&domain=x.com"    # 获取 Cookie
```

### 操作策略

- **程序化**（构造 URL、eval DOM）：快但可能触发反爬
- **GUI 交互**（click、fill、scroll）：慢但确定性高，站点不会限制
- 站点内交互产生的链接是可靠的，手动构造的 URL 可能缺必要参数
- `/scroll` 到底部触发懒加载；提取图片 URL 前先滚动确保加载完成
- DOM 有选择器不可跨越的边界（Shadow DOM、iframe），eval 递归遍历可穿透

### 登录判断

打开页面后先尝试获取内容。仅当内容无法获取且登录能解决时，提示用户在 Chrome 中登录。

### 任务结束

用 `/close` 关闭自己创建的 tab，保留用户原有 tab。Proxy 持续运行。

## 站点知识（四层递进）

访问 URL 前，先检查是否有站点知识可用：

```bash
node "<anyreach_dir>/scripts/adapter-runner.mjs" check "URL"
```

返回四种层级：

| level | 含义 | 操作 |
|-------|------|------|
| `adapter` | 本地代码适配器（.mjs） | `adapter-runner.mjs run "URL"` — 一步提取 |
| `hint` | 本地经验提示（.md） | `adapter-runner.mjs hint "URL"` — 获取提示后通用 CDP |
| `remote` | 远程有适配器可下载 | `adapter-runner.mjs run "URL"` — 自动下载后提取 |
| `none` | 无站点知识 | 直接通用 CDP 模式 |

`run` 命令遇到 `remote` 时自动下载到本地，无需手动操作。

```bash
node "<anyreach_dir>/scripts/adapter-runner.mjs" list               # 列出本地适配器
node "<anyreach_dir>/scripts/adapter-runner.mjs" run "URL"          # 运行（自动下载）
node "<anyreach_dir>/scripts/adapter-runner.mjs" hint "URL"         # 获取 .md 提示
node "<anyreach_dir>/scripts/adapter-runner.mjs" download "URL"     # 手动下载远程适配器
```

`run` 支持 `--ctx <json>` 传递适配器参数：

```bash
node "<anyreach_dir>/scripts/adapter-runner.mjs" run "URL" --ctx '{"maxPages":10,"limit":200}'
```

常用 ctx 参数：

| 参数 | 说明 | 默认 |
|------|------|------|
| `limit` | 最大条目数 | 20 |
| `maxPages` | 最多翻页数 | 5 |
| `mode` | 列表模式（`list` / `archive`） | `list` |
| `bidOnly` | 仅中标（opportunity 用） | `false` |
| `checkpointFile` | 每页写断点文件路径 | — |
| `resumePage` | 从断点文件继续 | `false` |

适配器失败时直接降级到 hint 或通用模式，不反复重试。

## 并行分治

多个独立目标时，利用 Agent 框架的并行能力分治执行：
- 任务描述写**目标**（"获取"、"调研"），不写具体手段（避免锚定到特定工具）
- 所有并行任务共享一个 CDP Proxy，各自创建/关闭自己的 tab，无竞态
- 并行任务需加载 anyreach skill 并遵循指引

## 批量爬取（Crawler）

需要批量提取多个 URL 时，使用 crawler 而非逐个手动操作：

```bash
# 准备 URL 列表文件（每行一个，# 开头为注释）
node "<anyreach_dir>/scripts/crawler.mjs" --urls urls.txt

# 常用参数
--concurrency 3          # 并发 worker 数（默认 3）
--delay 1000             # 请求间隔 ms（默认 1000）
--timeout 30000          # 单页超时 ms（默认 30000）
--retry 2                # 失败重试次数（默认 2）
--mode managed           # managed（默认，独立 Chrome）或 user（用户 Chrome）
--copy-cookies auto      # cookie 移植：auto（默认）/ true / false
--output results.ndjson  # 输出文件（默认 stdout）
--no-headless            # 显示浏览器窗口（调试用）
```

- 有 adapter 的 URL 自动走 adapter 提取，无 adapter 的 URL fallback 到通用 extractText
- managed mode 默认启动独立 headless Chrome，通过 cookie 移植获取登录态
- 输出 NDJSON 格式，每行一个 `{ url, status, adapter, data, error }`
- 进度和日志输出到 stderr，不干扰 NDJSON 数据流

## 站点专项：生财有术 (scys.com)

**登录要求**：精华帖、风向标等内容需要登录态。必须使用 user mode（直连用户 Chrome），不能用 managed mode。

### 页面类型

| URL 模式 | pageType | 说明 |
|----------|----------|------|
| `/?filter=essence` 或首页 | `essence` | 精华帖列表，`.compact-card`，分页 |
| `/opportunity` | `opportunity` | 风向标列表，`.post-item`，滚动加载 |
| `/activity` | `activity` | 航海项目列表 |
| `/course/detail/` | `course` | 航海手册，多章节逐章提取 |
| `/articleDetail/` | `article` | 帖子详情 |

### 精华帖内容类型

精华帖有两种形态，同一篇帖子也可能两者兼有：

- **站内内容**：正文直接在 `scys.com/articleDetail/` 页，`_extractArticle` 提取完整文本
- **飞书内容**：正文在飞书 wiki/docx，卡片 `externalLinks` 包含飞书 URL，需 feishu adapter 提取

`collect-urls.mjs` 默认同时输出两类 URL，crawler 自动走对应 adapter。

### 全量精华帖爬取流程

```bash
# 第一步：列表抓取（全量约 222 页，每页写 checkpoint）
node "<anyreach_dir>/scripts/adapter-runner.mjs" run "https://scys.com/?filter=essence" \
  --ctx '{"maxPages":999,"limit":9999,"checkpointFile":"/tmp/essence-cp.json"}' \
  > /tmp/essence-list.json

# 中断后续传（从 checkpoint 跳页继续）：
node "<anyreach_dir>/scripts/adapter-runner.mjs" run "https://scys.com/?filter=essence" \
  --ctx '{"maxPages":999,"limit":9999,"checkpointFile":"/tmp/essence-cp.json","resumePage":true}' \
  > /tmp/essence-list.json

# 第二步：从列表结果提取内容 URL（含飞书链接）
node "<anyreach_dir>/scripts/collect-urls.mjs" --input /tmp/essence-list.json --output /tmp/essence-urls.txt
# 仅飞书内容：追加 --filter feishu.cn
# 仅站内文章：追加 --only-internal

# 第三步：并发爬全文（user mode 保持登录态）
node "<anyreach_dir>/scripts/crawler.mjs" \
  --urls /tmp/essence-urls.txt --mode user --output /tmp/essence-full.ndjson
```

## 技术事实

- 页面中存在大量已加载但未展示的内容（轮播、折叠区块、懒加载占位），DOM 中可直接触达
- 短时间密集打开大量页面可能触发反爬
- 平台返回"内容不存在"可能是访问方式问题，不一定是内容问题
- 视频内容可通过 eval 操控 `<video>` 元素 + screenshot 采帧分析
