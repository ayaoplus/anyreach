# 生财有术适配器（scys.mjs）

生财有术（scys.com）社区内容提取，覆盖帖子、风向标、航海项目、航海手册四种页面类型。

## URL 路由

适配器通过 `detect(url)` 方法根据 URL 路径判断页面类型：

| URL 模式 | pageType | 说明 |
|---|---|---|
| `/articleDetail/` | `article` | 帖子详情 |
| `/opportunity` | `opportunity` | 风向标列表 |
| `/course/detail/` | `course` | 航海手册详情 |
| `/activity` | `activity` | 航海项目列表 |

不匹配任何模式时返回 `unknown`，adapter 会报错并提示支持的类型。

## 页面类型详解

### 帖子详情（article）

从 `.content-mt` 容器提取完整帖子内容。

提取字段：title、author、date、正文（innerText）、图片 URL、外部链接、标签、互动数据。

### 风向标列表（opportunity）

支持两种模式，通过 `ctx.mode` 参数切换：

**预览模式（`mode: 'list'`，默认）**

快速抓取卡片摘要，适合浏览概览。使用 `scrollToLoad` 滚动加载。

**归档模式（`mode: 'archive'`）**

完整内容提取，支持分页翻页：

1. 如果设置了 `bidOnly`，先点击"中标"tab 切换筛选
2. 逐页提取卡片的完整内容（分页器为 Arco Design 组件）
3. 每页提取后点击下一页按钮
4. 返回完整的正文、图片、AI 提炼、互动数据

关键发现：
- 风向标的"展开全文"只是 CSS 效果（`max-height` 截断），`innerText` 已包含完整文本，无需交互展开
- 页面使用分页（非无限滚动），底部有 Arco Design 分页器（`.arco-pagination`）
- 很多风向标没有独立详情页链接，内容主体就在列表卡片中

DOM 选择器：

| 元素 | 选择器 | 说明 |
|---|---|---|
| 卡片容器 | `.post-item` | 每条风向标 |
| 标题 | `.post-title` | 在 `.title-line` 下 |
| 中标标识 | `.hit-icon` | 中标徽章（非文本判断） |
| 分类 | `.title-line .icon` | 如"市场洞察" |
| 正文 | `.content-container` | 含 `.post-content` |
| 展开按钮 | `.flex-btn` | CSS 截断的视觉效果 |
| 图片 | `.image-list img` | 帖子图片 |
| 日期 | `.date` | 相对时间（"4天前"） |
| AI 提炼 | `.ai-summary-container` | 智能提炼文本 |
| 互动 | `.interactions .item` | 转发/点赞/评论/收藏 |

参数说明：

| 参数 | 默认值 | 说明 |
|---|---|---|
| `mode` | `'list'` | `'list'` 预览 / `'archive'` 归档 |
| `bidOnly` | `false` | 是否只提取中标风向标 |
| `limit` | `20` | 最大提取数量 |
| `maxPages` | `10` | 归档模式最大翻页数 |

### 航海手册详情（course）

从 `/course/detail/xxx` 页面逐章提取手册内容，输出结构化 Markdown。

提取流程：

1. 等待侧边栏 `.vc-course-sidebar` 加载
2. 获取课程标题（`.vc-course-info`）
3. 展开所有折叠的 section（`.vc-section-header:not(.expanded)`）
4. 提取目录结构（`.catalogue-section` > `.section-title` + `.vc-chapter-item`）
5. 按全局索引逐章点击（避免同名章节匹配歧义，如"00. 本章概要"）
6. 提取每章的 Markdown 内容

#### 章节内容转 Markdown

生财有术的手册底层使用**飞书文档 SDK** 渲染，DOM 结构为飞书的 block 体系：

| DOM 元素 | block 类型 | Markdown 输出 |
|---|---|---|
| `.block-header` > `.block6` | 标题（h2） | `## 标题` |
| `.block-header` > `.block7` | 标题（h3） | `### 标题` |
| `.block-header` > `.block8` | 标题（h4） | `#### 标题` |
| `.block-text` | 普通段落 | 文本 |
| `.block-text` + `.bold` span | 加粗文本 | `**文本**` |
| `.bullet_container` | 无序列表 | `- 文本` |
| `.block-image` | 图片 | `![图片](url)` |
| 空白 `.text.blank` | 空行 | 段落间距 |

转换在浏览器端执行（`EXTRACT_COURSE_CONTENT_JS`），不依赖外部库。

注意区分内容容器：
- 正确：`.vc-course-content` > `.feishu-doc-content`（只包含正文）
- 错误：`.content-mt`（会混入侧边栏文本）

### 航海项目列表（activity）

从 `/activity` 页面提取航海项目卡片列表。

使用 `scrollToLoad` 滚动加载 `.vc-navigation-card` 卡片，提取标题、描述、状态、日期范围、是否有"查看手册"按钮。

辅助方法 `openCourseFromActivity()` 可以点击卡片的"查看手册"按钮，等新 tab 打开后返回课程 URL。

## 修改指南

- **新增页面类型**：在 `detect()` 加 URL 匹配规则，在 `extract()` 加 switch case
- **修改 DOM 选择器**：更新对应的 JS 提取代码（`EXTRACT_*_JS` 常量）
- **测试**：
  ```bash
  # 预览模式
  node scripts/adapter-runner.mjs run "https://scys.com/opportunity"
  
  # 归档模式
  node -e "import { runAdapter } from './scripts/adapter-runner.mjs'; \
    const r = await runAdapter('https://scys.com/opportunity', { mode: 'archive', bidOnly: true, limit: 10 }); \
    console.log(JSON.stringify(r, null, 2));"
  
  # 手册提取
  node scripts/adapter-runner.mjs run "https://scys.com/course/detail/159"
  ```
