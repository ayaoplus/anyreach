# AnyReach CDP Proxy API 参考

## 基础信息

- 地址：`http://localhost:3456`（可通过 `CDP_PROXY_PORT` 环境变量修改）
- 启动：`node scripts/check-deps.mjs`（自动检测环境并启动 Proxy）
- 强制停止：`pkill -f cdp-proxy.mjs`

## 基础端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/targets` | GET | 列出所有页面 tab |
| `/new?url=` | GET | 创建后台 tab（自动等待加载） |
| `/close?target=` | GET | 关闭 tab |
| `/navigate?target=&url=` | GET | 导航（自动等待） |
| `/back?target=` | GET | 后退 |
| `/info?target=` | GET | 页面 title/url/readyState |
| `/eval?target=` | POST body=JS | 执行任意 JS |
| `/click?target=` | POST body=选择器 | JS `el.click()` |
| `/clickAt?target=` | POST body=选择器 | CDP 真实鼠标点击 |
| `/setFiles?target=` | POST JSON | 文件上传 |
| `/scroll?target=&direction=&y=` | GET | 滚动（down/up/top/bottom） |
| `/screenshot?target=&file=` | GET | 截图 |

## 增强端点（AnyReach 新增）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/extractText?target=` | POST JSON | 提取页面文本，自动滚动加载 |
| `/fill?target=` | POST JSON | 填写表单（支持批量） |
| `/waitFor?target=&selector=&timeout=` | GET | 等待元素出现 |
| `/setCookie?target=` | POST JSON | 注入 Cookie（支持 HttpOnly） |
| `/getCookies?target=&domain=` | GET | 获取 Cookie |
| `/adapter?url=` | POST | 调用站点适配器 |

## /extractText 详细

提取指定容器内的可见文本，自动处理滚动和懒加载。

```bash
curl -s -X POST "http://localhost:3456/extractText?target=ID" \
  -d '{"selector":".content-area","scroll":true}'
```

参数：
- `selector`：容器选择器，默认 `body`
- `scroll`：是否先滚动触发懒加载，默认 `true`

返回：`{ text, length }`

## /fill 详细

填写表单字段，支持 React/Vue 等框架（通过原生 setter 触发响应式更新）。

```bash
# 单字段
curl -s -X POST "http://localhost:3456/fill?target=ID" \
  -d '{"selector":"#username","value":"test"}'

# 批量
curl -s -X POST "http://localhost:3456/fill?target=ID" \
  -d '[{"selector":"#username","value":"test"},{"selector":"#password","value":"pass"}]'
```

## /setCookie 详细

通过 CDP `Network.setCookie` 注入 Cookie，支持 HttpOnly 属性。

```bash
curl -s -X POST "http://localhost:3456/setCookie?target=ID" \
  -d '{"name":"auth_token","value":"xxx","domain":".x.com","path":"/","httpOnly":true,"secure":true}'
```

## /waitFor 详细

使用 MutationObserver 监听 DOM 变化，等待目标元素出现。

```bash
curl -s "http://localhost:3456/waitFor?target=ID&selector=.loaded&timeout=5000"
```

返回 `{ found, tag, text }` 或 `{ found: false, timeout: true }`（HTTP 408）。

## /eval 使用提示

- POST body 为 JS 表达式，支持 async/await
- 返回值必须可序列化（字符串、数字、对象），DOM 节点需提取属性
- 大量数据用 `JSON.stringify()` 包裹
- 根据页面实际 DOM 编写选择器，不套固定模板
