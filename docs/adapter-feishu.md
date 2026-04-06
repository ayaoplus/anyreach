# 飞书适配器（feishu.mjs）

飞书知识库（wiki）和云文档（docx）的结构化内容提取。输出 Markdown 格式。

## 核心原理

飞书文档在浏览器中通过 `window.DATA.clientVars.data` 暴露文档的 block 数据。每个 block 包含类型（`type`）、文本内容、样式属性和子 block 引用。适配器直接从这个内存对象中读取数据，完全绕过飞书的虚拟列表渲染。

### 为什么不从 DOM 提取？

飞书文档使用**虚拟列表**渲染：

- 整个文档只有约 24 个 DOM 节点同时存在
- 滚走的 block 被回收，不是隐藏
- `scrollTop` 赋值不会触发虚拟列表更新（需要真实输入事件）
- Selection API、innerText 只能拿到当前视口的内容

因此，DOM 路径不可行，必须走数据层。

## 长文档分 slice 加载

飞书对长文档做分片加载（初始 HTML 嵌入第一个 slice，约 239 个 block）：

```
window.DATA.clientVars.data.has_more = true   → 有后续 slice
window.DATA.clientVars.data.has_more = false   → 数据完整
```

### 后续 slice 的获取路径

```
页面加载 → docxClientvarFetchManager 创建 Web Worker
         → Worker 请求 /space/api/docx/pages/client_vars?cursor=xxx
         → 数据存在 Worker 内存中，不回写 window.DATA
```

适配器的解决方案：

1. 通过 CDP `Target.setAutoAttach` + `waitForDebuggerOnStart` 捕获 Worker session
2. CDP proxy 自动在 Worker 上启用 `Network.enable` 后恢复执行
3. 刷新页面触发 Worker 重新创建和数据加载
4. 通过 Worker 的 `performance.getEntriesByType("resource")` 获取 API URL
5. 在 Worker 内 `Runtime.evaluate` 重新 fetch 获取完整 block 数据
6. 合并到主线程的 block_map

关键细节：Worker 的 fetch 请求不出现在主线程的 `Network` 域事件中，必须 attach 到 Worker target 才能访问。

## Block 类型映射

所有映射在代码中是确定性的，不依赖 LLM。

| block type | Markdown 输出 | 说明 |
|---|---|---|
| `page` | `# 标题` | 文档顶层标题 |
| `heading1` ~ `heading5` | `##` ~ `#####` | 文档内标题（heading1 映射到 h2） |
| `heading6` ~ `heading9` | `#####` | 超深层级统一为 h5 |
| `text` | 段落文本 | 默认 block 类型 |
| `bullet` | `- 文本` | 无序列表 |
| `ordered` | `1. 文本` | 有序列表（自动计数） |
| `todo` | `- [ ] 文本` / `- [x] 文本` | 待办事项（读取 `data.done`） |
| `code` | ` ``` ` 代码块 | 代码块 |
| `divider` | `---` | 分隔线 |
| `image` | `![图片](cdn_url)` | 图片（token 转 CDN URL） |
| `quote_container` | `> ` + 递归 children | 引用块（本身无文本，内容在子 block 中） |
| `callout` | emoji + `> ` + 递归 children | 高亮提示块（带背景色和 emoji） |
| `iframe` | `> 📹 妙记: URL` 等 | 嵌入内容（视频、妙记、网页） |
| `table` | Markdown 表格 | 原生表格（见下方详解） |
| `table_cell` | 由 table 统一处理 | 单元格内容在 children 中 |
| `grid` / `grid_column` | 透传 children | 多列布局容器 |
| `sheet` | `> 📊 [电子表格]` | 嵌入电子表格（canvas+protobuf，无法内联） |
| `base_refer` | `> 📊 [多维表格引用]` | 多维表格引用 |
| `isv` | 跳过 | 第三方应用块 |
| `file` | `> 📎 文件名` | 附件文件 |
| `chat_card` | 跳过 | 群聊卡片 |

### 加粗处理

飞书使用 EtherPad Changeset 格式存储行内样式：

```
apool.numToAttrib: { "0": ["author", "xxx"], "1": ["bold", "true"] }
attribs: "*0*1+u"   → 用属性 0 和 1，长度 0x1e（30 字符）
```

当前实现：检测 apool 中是否有 `bold: true`，如果整段加粗则包裹 `**...**`。部分加粗（段内混合样式）暂未实现。

### 原生表格解析

飞书原生表格的数据结构：

```
table block:
  columns_id: ["col_uuid1", "col_uuid2", ...]     → 列定义
  rows_id:    ["row_uuid1", "row_uuid2", ...]     → 行定义
  cell_set:   { "row_uuid1col_uuid1": { block_id: "xxx" }, ... }  → 单元格映射
  header_row: true/false                           → 是否有表头行
```

- `cell_set` 的 key 是 `rowId + colId` 拼接
- 每个 cell 的 `block_id` 指向 `block_map` 中的 `table_cell` block
- `table_cell` 本身没有文本，内容在其 `children` 子 block 中
- 按 `rows_id × columns_id` 顺序遍历，生成标准 Markdown 表格

### 图片 URL 转换

block 中存储的是 image token，需要转换为 CDN URL：

```
token: "R5TJbwHZwold3dxfoN2c34m8ntf"
→ https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/{token}/?fallback_source=1&height=1280&mount_node_token={blockId}&mount_point=docx_image
```

注意：此 URL 需要飞书登录态 cookie 才能访问，在 Obsidian 等工具中无法直接显示。

## 不支持的内容

| 类型 | 原因 |
|---|---|
| 嵌入电子表格（sheet） | canvas 渲染 + protobuf 数据格式，无法从 DOM 或 block 数据中提取 |
| 多维表格（base_refer） | 独立数据源，需要单独的 API 调用 |
| 行内部分加粗/颜色 | EtherPad Changeset 解析复杂度高，暂未实现 |
| 图片本地化 | CDN URL 需要 cookie，下载需要通过 CDP proxy 代理 |

## 修改指南

- **新增 block 类型**：在 `blocksToMarkdown()` 的 `switch` 中添加 `case`
- **修改样式映射**：直接改对应 `case` 中的 Markdown 输出格式
- **容器类 block**（有 children 的）：注意用 `return` 跳过通用的 children 递归，避免重复输出
- **测试**：`node scripts/adapter-runner.mjs run "飞书URL"` 直接查看 JSON 输出
