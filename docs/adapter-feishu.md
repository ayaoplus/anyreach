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

### 数据结构

```
window.DATA.clientVars.data
  ├── block_map          所有 block 的 id → data 映射
  ├── block_sequence     顶层 block 的渲染顺序数组
  ├── has_more           是否有后续 slice 未加载（boolean）
  ├── next_cursors       后续 slice 的 cursor 数组
  └── id                 文档 token（用于 API 调用）
```

每个 block 有 `children` 数组定义嵌套结构。`blocksToMarkdown()` 从 root block（`block_sequence[0]`）开始递归遍历 children 树，生成 Markdown。

## 长文档分 slice 加载

飞书对长文档做分片加载。初始 HTML 嵌入第一个 slice（约 200-250 个 block）。

```
has_more = false  → 数据完整，直接提取
has_more = true   → 需要 fetch 后续 slice
```

### 后续 slice 获取（page-level fetch 方案）

当 `has_more` 为 true 时，适配器直接在**页面上下文**中调用飞书内部 API 获取剩余 block：

```
GET /space/api/docx/pages/client_vars?id={docId}&mode=7&limit=500&cursor={cursor}
```

返回 JSON 结构和 `window.DATA.clientVars.data` 相同，包含 `block_map`、`has_more`、`next_cursors`。适配器循环 fetch 直到 `has_more` 为 false，合并所有 `block_map`。

**为什么不用 Worker 拦截？** 之前的方案通过 CDP `autoAttach` 捕获飞书的 Web Worker，从 Worker 内部读取 API URL 并重新 fetch。这个方案**不稳定**——依赖 Worker 创建时序、autoAttach 竞态、固定等待时间，在不同 Chrome 状态下随机失败。page-level fetch 直接用同一页面的 cookie 调 API，无时序依赖。

### 关键注意事项

1. **cursor 返回的 block 不一定是文章正文**——可能包含评论、分块元数据等额外内容。`blocksToMarkdown` 只遍历 root block 的后代树，不在树上的 block 会被自然忽略。这是**正确行为**，不是 bug。

2. **`workerBlockCount` 字段**：输出中的 `meta.workerBlockCount` 表示 cursor fetch 获取的 block 数量（历史命名，实际已不通过 Worker 获取）。这个数字可能大于实际新增到 markdown 中的内容，因为部分 cursor block 可能已存在于初始 block_map 中，或不在 root 树上。

3. **`has_more` 在结果中仍为 `true`**：这反映的是初始 `window.DATA` 的状态（fetch 前），不代表最终数据不完整。检查 `contentLength` 和实际 markdown 内容来判断完整性。

## 从 scys.com 调用时的行为

scys 适配器的 `_extractArticle` 检测到飞书链接时，会 `newTab` 打开飞书 URL，调用 feishu adapter 的 `extract()` 方法。注意：

- 飞书 tab 是独立的（不是 iframe），`window.DATA` 正常可用
- feishu adapter 的 `extract()` 内部会自行等待数据就绪（`WAIT_FOR_DATA_JS` 轮询 15 秒）
- scys 调用前的 3 秒 `sleep` 是等初始页面加载，adapter 内部还有额外等待
- 提取完成后 scys adapter 会关闭飞书 tab

## Markdown 转换

### Block 类型映射

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

### 遍历逻辑

`blocksToMarkdown(allBlocks, rootId)` 从 root block 开始，递归遍历 `children` 数组。**只有 root 的后代会被渲染**——block_map 中存在但不在 root 树上的 block 会被跳过（如评论块、cursor 返回的额外元数据）。

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

按 `rows_id × columns_id` 顺序遍历，生成标准 Markdown 表格。

### 图片 URL 转换

block 中存储的是 image token，转换为 CDN URL：

```
token: "R5TJbwHZwold3dxfoN2c34m8ntf"
→ https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/{token}/?fallback_source=1&height=1280&mount_node_token={blockId}&mount_point=docx_image
```

注意：此 URL 需要飞书登录态 cookie 才能访问。

## 输出格式

```json
{
  "title": "文档标题",
  "markdown": "# 标题\n\n正文...",
  "content": "# 标题\n\n正文...",
  "format": "markdown",
  "meta": {
    "blockCount": 378,
    "workerBlockCount": 139,
    "hasMore": true
  },
  "images": ["url1", "url2"],
  "contentLength": 18724
}
```

`markdown` 和 `content` 是同一个值（兼容不同调用方的字段名约定）。

## 不支持的内容

| 类型 | 原因 |
|---|---|
| 嵌入电子表格（sheet） | canvas 渲染 + protobuf 数据格式 |
| 多维表格（base_refer） | 独立数据源，需要单独 API |
| 行内部分加粗/颜色 | EtherPad Changeset 解析复杂度高 |
| 图片本地化 | CDN URL 需要 cookie |

## 修改指南

- **新增 block 类型**：在 `blocksToMarkdown()` 的 `switch` 中添加 `case`
- **容器类 block**（有 children）：注意用 `return` 跳过通用的 children 递归，避免重复输出
- **长文档调试**：检查 `meta.blockCount`（总 block 数）和 `meta.workerBlockCount`（cursor fetch 数），但 markdown 长度取决于有多少 block 在 root 树上
- **测试**：`node scripts/adapter-runner.mjs run "飞书URL"` 直接查看 JSON 输出
