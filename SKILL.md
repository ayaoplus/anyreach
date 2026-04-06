---
name: anyreach
description:
  Agent 联网与浏览器操作 skill。覆盖搜索、网页抓取、登录后操作、浏览器自动化、站点适配器。
  触发场景：搜索信息、查看网页、操作网页界面、抓取社交媒体内容、读取动态渲染页面。
---

# AnyReach

## 前置检查

```bash
node "$CLAUDE_SKILL_DIR/scripts/check-deps.mjs"
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
| 搜索关键词、发现信息来源 | **WebSearch** |
| URL 已知，公开页面提取信息 | **WebFetch** 或 **Jina**（`r.jina.ai/example.com`，文章类页面省 token） |
| 需要原始 HTML（meta、JSON-LD） | **curl** |
| 反爬平台、需登录态、需交互操作 | **CDP Proxy** |

一手信息优于二手信息。搜索引擎是发现入口，不是证明手段。

## CDP Proxy

直连用户日常 Chrome，天然携带登录态。所有操作在后台 tab 中，不干扰用户。

### 启动

```bash
node "$CLAUDE_SKILL_DIR/scripts/check-deps.mjs"
```

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

## 站点知识（三层递进）

访问 URL 前，先检查是否有站点知识可用：

```bash
node "$CLAUDE_SKILL_DIR/scripts/adapter-runner.mjs" check "URL"
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
node "$CLAUDE_SKILL_DIR/scripts/adapter-runner.mjs" list               # 列出本地适配器
node "$CLAUDE_SKILL_DIR/scripts/adapter-runner.mjs" run "URL"          # 运行（自动下载）
node "$CLAUDE_SKILL_DIR/scripts/adapter-runner.mjs" hint "URL"         # 获取 .md 提示
node "$CLAUDE_SKILL_DIR/scripts/adapter-runner.mjs" download "URL"     # 手动下载远程适配器
```

适配器失败时直接降级到 hint 或通用模式，不反复重试。

## 并行分治

多个独立目标时，分发子 Agent 并行执行：
- 子 Agent prompt 写**目标**（"获取"、"调研"），不写具体手段（"搜索"会锚定 WebSearch）
- 所有子 Agent 共享一个 Proxy，各自创建/关闭自己的 tab，无竞态
- 子 Agent 必须加载 anyreach skill 并遵循指引

## 技术事实

- 页面中存在大量已加载但未展示的内容（轮播、折叠区块、懒加载占位），DOM 中可直接触达
- 短时间密集打开大量页面可能触发反爬
- 平台返回"内容不存在"可能是访问方式问题，不一定是内容问题
- 视频内容可通过 eval 操控 `<video>` 元素 + screenshot 采帧分析
