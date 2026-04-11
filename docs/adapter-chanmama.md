# 蝉妈妈适配器（chanmama.mjs）

蝉妈妈（chanmama.com）达人库筛选与达人数据提取。支持条件组合筛选、保存条件加载、结果列表提取（含详情页 URL）、自动翻页、达人详情页简介提取（自动展开长文本）。

**登录要求**：达人库需要登录态，必须使用 user mode（直连用户 Chrome）。

## URL 路由

| URL 模式 | pageType | 说明 |
|---|---|---|
| `/bloggerRank` | `bloggerRank` | 达人库（筛选 + 列表） |
| `/bloggerRank/ID.html` | `bloggerDetail` | 达人详情页（ID 为 base64 字符串） |

## Action 列表

通过 `ctx.action` 分发，默认 `extractResults`。

| Action | 说明 | 参数 |
|---|---|---|
| `applyFilters` | 组合筛选条件并搜索 | `filters` 对象 |
| `applySavedCondition` | 加载已保存的常用条件 | `conditionName: string` |
| `extractResults` | 提取当前页达人列表 | — |
| `extractAll` | 提取多页（自动翻页） | `maxPages: number`（默认 5） |
| `getFilterState` | 获取当前筛选状态 | — |
| `nextPage` | 翻到下一页 | — |
| `gotoPage` | 跳转指定页码 | `page: number` |
| `search` | 点击搜索按钮 | — |
| `extractBio` | 提取达人简介（详情页） | — |

## 筛选条件（applyFilters）

`filters` 对象支持以下字段，全部可选，按需组合：

| 字段 | 类型 | 取值范围 | 说明 |
|---|---|---|---|
| `category` | string | `全部` `服饰内衣` `鞋靴箱包` `食品饮料` `美妆护肤` `运动户外` `日用百货` `家居家纺` `母婴用品` `医药保健` `3C数码` `厨卫家电` 等 | 带货分类一级 |
| `subCategory` | string | 依赖一级分类，如日用百货下：`个人护理` `生活日用` `家庭清洁` `收纳整理` `计生用品` | 带货分类二级 |
| `bloggerGender` | string | `不限` `男` `女` | 达人画像性别 |
| `fanGender` | string | `全部` `男性居多` `女性居多` | 粉丝画像性别 |
| `checkDaren` | boolean | `true` / `false` | 勾选"达人号" |
| `levels` | string[] | `LV0` `LV1` `LV2` `LV3` `LV4` `LV5` `LV6` | 带货等级（多选） |
| `sellMode` | string | `不限` `直播带货为主` `视频带货为主` `图文带货为主` | 带货方式 |
| `liveHourlyOutput` | string | `不限` `<1000` `1000-1万` `1万-10万` `10万-50万` `50万-100万` `100万-500万` `>500万` | 直播场均小时产出 |

### 使用示例

```javascript
// 完整条件组合
await adapter.extract(proxy, targetId, {
  action: 'applyFilters',
  filters: {
    category: '日用百货',
    subCategory: '个人护理',
    bloggerGender: '女',
    fanGender: '女性居多',
    checkDaren: true,
    levels: ['LV1', 'LV2', 'LV3', 'LV4'],
    sellMode: '直播带货为主',
    liveHourlyOutput: '1000-1万',
  }
});
```

返回值：

```json
{
  "action": "applyFilters",
  "steps": [
    { "step": "category", "value": "日用百货", "ok": true },
    { "step": "subCategory", "value": "个人护理", "ok": true },
    { "step": "bloggerGender", "value": "女", "ok": true },
    ...
  ]
}
```

## 保存条件（applySavedCondition）

加载蝉妈妈页面上已保存的常用条件（"快捷操作"区域）。

```javascript
await adapter.extract(proxy, targetId, {
  action: 'applySavedCondition',
  conditionName: '阿周'
});
```

## 结果提取（extractResults / extractAll）

提取达人列表。字段动态映射表头，不受列表配置变化影响。

```javascript
// 当前页
const result = await adapter.extract(proxy, targetId, { action: 'extractResults' });

// 前 N 页（自动翻页）
const result = await adapter.extract(proxy, targetId, { action: 'extractAll', maxPages: 3 });
```

返回值：

```json
{
  "action": "extractResults",
  "bloggers": [
    {
      "name": "达人名称",
      "douyinId": "抖音号",
      "hasLevel": true,
      "avatar": "头像 URL",
      "profileLink": "蝉妈妈达人主页 URL",
      "followers": "粉丝数（含活跃粉丝）",
      "liveSessions": "直播场次",
      "avgViews": "平均场观",
      "avgStayTime": "平均停留时长",
      "avgOnline": "平均在线人数",
      "liveSales": "直播销售额",
      "liveHourlyOutput": "直播小时产出",
      "avgSessionSales": "场均销售额"
    }
  ],
  "pagination": { "current": 1, "total": 100 }
}
```

**注意**：输出字段取决于用户的"列表配置"。上述字段在直播相关配置下出现。切换为默认配置时会有 `sales`、`videoSales`、`likeRatio`、`newFollowers` 等字段。适配器按表头名动态映射，无需修改代码。

**`profileLink` 字段**：即达人详情页的 URL，格式为 `https://www.chanmama.com/bloggerRank/ID.html`。可直接用于导航到详情页提取更多数据。

## 达人详情页（extractBio）

提取达人简介，自动处理长文本展开。

```javascript
// 在详情页上提取简介
const result = await adapter.extract(proxy, targetId, {
  action: 'extractBio',
  pageType: 'bloggerDetail',  // adapter-runner 自动设置
});
```

返回值：

```json
{
  "action": "extractBio",
  "bio": "达人的完整简介文本，支持多行",
  "wasTruncated": true,
  "wasExpanded": true
}
```

### DOM 结构

```
.personal-intro-row
  span.fs12.c666.mr6          → "达人简介" 标签
  .intro-content
    span.intro-text.fs12.c333 → 简介正文（CSS -webkit-line-clamp:2 截断）
    span.more-link.fs12       → "复制" 或 "展开"
```

### 展开逻辑

简介默认被 CSS `-webkit-line-clamp: 2` 截断为两行。Vue 组件通过 `isMore`/`noMore` 控制展开状态：
- `noMore = true`：文本不超过 2 行，无需展开
- `noMore = false` 且 `isMore = false`：文本被截断，显示"展开"按钮
- `noMore = false` 且 `isMore = true`：文本已展开

适配器处理策略：
1. 检测 `scrollHeight > clientHeight` 判断是否有截断
2. 如果有截断，先尝试点击"展开"按钮
3. 兜底方案：直接移除 CSS `-webkit-line-clamp` 限制，确保读取到完整文本
4. 提取完成后恢复 CSS 样式

## 技术要点

### DOM 交互

蝉妈妈基于 Vue 2 + Element UI，所有筛选交互必须通过 CDP 真实鼠标点击（`proxy.clickAt`），JS `.click()` 无法触发 Vue 事件绑定。

交互模式统一为：
1. `proxy.eval` 在 DOM 中找到目标元素，设置临时 id `#__chanmama_tmp`
2. `proxy.clickAt(targetId, '#__chanmama_tmp')` 发送 CDP 鼠标事件

### 关键坑点

| 问题 | 原因 | 解决方案 |
|---|---|---|
| 后台 tab 点击无效 | CDP `Input.dispatchMouseEvent` 仅在前台 tab 生效 | `clickAt` 前调用 `Target.activateTarget` |
| 带货分类点击无反应 | 每个分类是 `<span><span class="el-tooltip">文字</span></span>` 双层结构，必须点外层 | 遍历 `wrapper.children` 而非 `querySelectorAll('span')` |
| 二级分类不弹出 | popover 仅在分类从未选中→选中时弹出 | 先点"全部"重置，再点目标分类 |
| 达人画像/粉丝画像不生效 | 面板是折叠 popover，选完值后需点"确定" | 先 `openPanel` → 选值 → `clickPopoverConfirm` |
| 带货等级/带货方式选不中 | 选项在 popover 内的 `.item` div 中 | 先点 `.input-box` 打开面板，再点 popover 内选项 |
| 筛选区有两个 `.condition-box` | 第一个是保存条件区，第二个是筛选行 | 用 `.condition-box.pl20` 选择器定位筛选行 |
