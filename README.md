[English](README_EN.md)

# AnyReach

AI Agent 的智能联网工具。基于 CDP 浏览器自动化，配合站点适配器系统，实现确定性内容提取。

## 它做什么

AnyReach 将你的 AI Agent（Claude Code、Codex、OpenClaw）连接到你日常使用的 Chrome 浏览器。Agent 在后台标签页中操作——共享你的登录状态，对反爬检测不可见，不会抢占你的浏览器焦点。

三层站点知识体系：

| 层级 | 机制 | Token 消耗 | 适用场景 |
|------|------|-----------|---------|
| **代码适配器** (.mjs) | 确定性代码提取 | 零 | 有已知内部 API 的站点（如飞书的 `window.DATA`） |
| **提示文件** (.md) | 基于 prompt 的经验指引 | 低 | 有已知模式但不适合写固定脚本的站点 |
| **通用模式** | Agent 通过 `/eval` 实时编写 JS | 高 | 未知站点、一次性任务 |

## 安装

**让 Agent 自动安装：**

```
Install this skill: https://github.com/ayaoplus/anyreach
```

**手动安装：**

```bash
git clone https://github.com/ayaoplus/anyreach ~/anyreach
node ~/anyreach/scripts/install.mjs
```

安装会创建符号链接：
- `~/.claude/skills/anyreach` → Claude Code
- `~/.agents/skills/anyreach` → Codex + OpenClaw

一份代码，共享 `SKILL.md`，所有 Agent 都能加载。

### 前置条件

- **Node.js 22+**（使用原生 WebSocket）
- **Chrome** 开启远程调试：
  1. 打开 `chrome://inspect/#remote-debugging`
  2. 勾选 **"Allow remote debugging for this browser instance"**
  3. 如需要，重启 Chrome

### 验证

```bash
node ~/anyreach/scripts/check-deps.mjs
# 预期输出: node: ok, chrome: ok, proxy: ready
```

## 使用方式

安装后，直接对 Agent 说：

- *"读取这个页面：[URL]"*
- *"搜索小红书上的 X"*
- *"提取这个飞书文档的内容"*
- *"并行调研这 5 个竞品"*

Agent 会加载 SKILL.md，选择合适的工具（WebSearch / WebFetch / Jina / CDP），自动完成任务。

## CDP Proxy API

所有浏览器操作通过本地 HTTP 代理 `localhost:3456` 完成。

### 基础端点

```bash
curl -s "http://localhost:3456/new?url=URL"                          # 新建后台标签页
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'JS'      # 执行 JavaScript
curl -s -X POST "http://localhost:3456/click?target=ID" -d '.btn'   # JS 点击
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d '.btn' # 真实鼠标点击
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"    # 滚动
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/s.png" # 截图
curl -s "http://localhost:3456/close?target=ID"                      # 关闭标签页
```

### 增强端点

```bash
curl -s -X POST "http://localhost:3456/extractText?target=ID" \
  -d '{"selector":".content","scroll":true}'                         # 自动滚动 + 提取文本
curl -s -X POST "http://localhost:3456/fill?target=ID" \
  -d '{"selector":"input","value":"text"}'                           # 填写表单（兼容 React/Vue）
curl -s "http://localhost:3456/waitFor?target=ID&selector=.loaded"   # 等待元素出现
curl -s -X POST "http://localhost:3456/setCookie?target=ID" \
  -d '{"name":"k","value":"v","domain":".x.com","httpOnly":true}'    # 注入 Cookie
```

### 高级端点

```bash
curl -s -X POST "http://localhost:3456/cdp?target=ID" \
  -d '{"method":"Network.enable","params":{}}'                       # 发送任意 CDP 命令
curl -s "http://localhost:3456/wheel?target=ID&x=400&y=300&deltaY=500" # 真实滚轮事件
curl -s -X POST "http://localhost:3456/events/start?target=ID" \
  -d '{"filter":"Network","maxEvents":1000}'                         # 开始收集 CDP 事件
curl -s "http://localhost:3456/events/get?id=COL_ID"                 # 获取收集到的事件
```

完整参考：[docs/architecture.md](docs/architecture.md)

## 适配器系统

四层解析：本地代码适配器 → 本地提示文件 → 远程注册表 → 通用 CDP 模式。

遇到远程适配器时自动下载到 `adapters/` 并执行，无需手动配置。

### 查看 URL 匹配情况

```bash
node scripts/adapter-runner.mjs check "https://feishu.cn/wiki/xxx"
# {"level":"adapter","name":"feishu",...}

node scripts/adapter-runner.mjs check "https://unknown-site.com"
# {"level":"none"}
```

### 运行适配器

```bash
node scripts/adapter-runner.mjs run "https://feishu.cn/wiki/xxx"
# 返回结构化 JSON（title, content, metadata）
```

### 编写自己的适配器

复制 `adapters/_template.mjs`：

```javascript
export default {
  name: 'mysite',
  domains: ['mysite.com'],
  description: '从 mysite 提取文章',

  detect(url) {
    if (url.includes('/post/')) return 'post';
    return 'default';
  },

  async extract(proxy, targetId, ctx) {
    const title = await proxy.eval(targetId, 'document.title');
    const { text } = await proxy.extractText(targetId, { selector: 'article' });
    return { title, content: text, format: 'text' };
  },
};
```

## 已有适配器

| 适配器 | 域名 | 能力 |
|--------|------|------|
| **feishu** | feishu.cn, larksuite.com | 知识库/云文档提取。通过 `window.DATA` block 数据 + Worker 拦截实现长文档完整提取。支持所有 block 类型（标题、列表、图片、表格、高亮块、引用等）输出 Markdown |
| **xiaohongshu** | xiaohongshu.com, xhslink.com | 笔记（图文/视频）、用户主页、信息流。滚动加载、批量提取 |
| **scys** | scys.com | 帖子详情、风向标列表（预览/归档两种模式）、航海项目、航海手册（逐章提取，输出 Markdown） |

## 项目结构

```
SKILL.md              Agent 策略提示词（浏览哲学、工具选择）
registry.json         远程适配器注册表（自动下载索引）
scripts/
  cdp-proxy.mjs       HTTP → Chrome CDP 桥接（24+ 端点）
  check-deps.mjs      环境检查 + proxy 自动启动
  adapter-runner.mjs   四层匹配器 + 远程下载
  install.mjs         安装脚本（创建符号链接）
adapters/
  _utils.mjs          共享工具（sleep, downloadFile, scrollToLoad）
  _template.mjs       适配器模板
  feishu.mjs          飞书知识库/云文档（window.DATA + Worker block 补全）
  xiaohongshu.mjs     小红书笔记、主页、信息流
  scys.mjs            生财有术帖子、风向标、航海手册
docs/
  architecture.md     整体架构设计
  adapter-feishu.md   飞书适配器技术文档
  adapter-scys.md     生财有术适配器技术文档
  crawler-design.md   爬虫功能设计（规划中）
```

### 适配器技术文档

- [飞书适配器](docs/adapter-feishu.md) — block 数据提取原理、长文档 Worker 拦截机制、原生表格解析、block 类型完整映射表
- [生财有术适配器](docs/adapter-scys.md) — 四种页面类型路由、风向标归档模式（分页+中标筛选）、航海手册逐章 Markdown 提取

## 致谢

架构灵感来自 [web-access](https://github.com/eze-is/web-access)（作者：一泽 Eze）。AnyReach 在 web-access 的基础上增加了适配器系统、增强的 CDP 端点和 Worker 级别的数据拦截能力。

## 许可证

MIT
