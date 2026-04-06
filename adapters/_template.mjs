// AnyReach 站点适配器模板
// 复制此文件并重命名为 {domain}.mjs，实现对应站点的提取逻辑
//
// 适配器接口：
//   - name: 适配器名称
//   - domains: 匹配的域名列表
//   - description: 简短描述
//   - detect(url): 根据 URL 判断页面类型，返回字符串
//   - extract(proxy, targetId, ctx): 提取页面内容，返回结构化数据
//
// proxy 是 ProxyClient 实例，提供以下方法：
//   proxy.eval(targetId, js)           — 执行 JS，返回值
//   proxy.scroll(targetId, opts)       — 滚动 { direction, y }
//   proxy.screenshot(targetId, file)   — 截图到文件
//   proxy.click(targetId, selector)    — JS 点击
//   proxy.clickAt(targetId, selector)  — 真实鼠标点击
//   proxy.extractText(targetId, opts)  — 提取文本 { selector, scroll }
//   proxy.fill(targetId, fields)       — 填写表单
//   proxy.waitFor(targetId, sel, ms)   — 等待元素出现
//   proxy.navigate(targetId, url)      — 导航到 URL
//   proxy.info(targetId)               — 获取页面 title/url/readyState
//   proxy.close(targetId)              — 关闭 tab
//   proxy.setCookie(targetId, cookie)  — 注入 Cookie
//   proxy.getCookies(targetId, domain) — 获取 Cookie

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default {
  name: 'example',
  domains: ['example.com'],
  description: '示例适配器',

  // 根据 URL 判断页面类型
  detect(url) {
    if (url.includes('/article/')) return 'article';
    return 'default';
  },

  // 提取页面内容
  // ctx: { url, pageType }
  async extract(proxy, targetId, ctx) {
    // 等待页面关键元素加载
    await proxy.waitFor(targetId, 'article', 10000);

    // 提取标题
    const title = await proxy.eval(targetId, 'document.title');

    // 提取正文
    const { text } = await proxy.extractText(targetId, {
      selector: 'article',
      scroll: true,
    });

    return {
      title,
      content: text,
      format: 'text',
    };
  },
};
