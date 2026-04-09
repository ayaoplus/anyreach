// ProxyClient — CDP Proxy HTTP 客户端
// 供 adapter-runner、crawler 等模块共享使用

export class ProxyClient {
  constructor(port) {
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
  }

  // 通用 HTTP 请求，供内部方法和外部直接调用
  async fetch(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, opts);
    return res.json();
  }

  // 创建新 tab，返回 targetId
  async newTab(url) {
    const r = await this.fetch(`/new?url=${encodeURIComponent(url)}`);
    return r.targetId;
  }

  // 关闭 tab
  async close(targetId) {
    return this.fetch(`/close?target=${targetId}`);
  }

  // 页面信息
  async info(targetId) {
    return this.fetch(`/info?target=${targetId}`);
  }

  // 执行 JS，返回值
  async eval(targetId, js) {
    const r = await this.fetch(`/eval?target=${targetId}`, {
      method: 'POST', body: js,
    });
    if (r.error) throw new Error(r.error);
    return r.value;
  }

  // 导航
  async navigate(targetId, url) {
    return this.fetch(`/navigate?target=${targetId}&url=${encodeURIComponent(url)}`);
  }

  // 滚动
  async scroll(targetId, opts = {}) {
    const params = new URLSearchParams({ target: targetId, ...opts });
    return this.fetch(`/scroll?${params}`);
  }

  // 截图
  async screenshot(targetId, filePath) {
    return this.fetch(`/screenshot?target=${targetId}&file=${encodeURIComponent(filePath)}`);
  }

  // JS 点击
  async click(targetId, selector) {
    return this.fetch(`/click?target=${targetId}`, {
      method: 'POST', body: selector,
    });
  }

  // 真实鼠标点击
  async clickAt(targetId, selector) {
    return this.fetch(`/clickAt?target=${targetId}`, {
      method: 'POST', body: selector,
    });
  }

  // 提取文本（增强端点）
  async extractText(targetId, opts = {}) {
    return this.fetch(`/extractText?target=${targetId}`, {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  }

  // 填写表单
  async fill(targetId, fields) {
    return this.fetch(`/fill?target=${targetId}`, {
      method: 'POST',
      body: JSON.stringify(fields),
    });
  }

  // 等待元素
  async waitFor(targetId, selector, timeout = 10000) {
    return this.fetch(`/waitFor?target=${targetId}&selector=${encodeURIComponent(selector)}&timeout=${timeout}`);
  }

  // 注入 Cookie
  async setCookie(targetId, cookie) {
    return this.fetch(`/setCookie?target=${targetId}`, {
      method: 'POST',
      body: JSON.stringify(cookie),
    });
  }

  // 获取 Cookie
  async getCookies(targetId, domain) {
    const params = domain ? `&domain=${domain}` : '';
    return this.fetch(`/getCookies?target=${targetId}${params}`);
  }

  // 注入页面前置脚本（在后续导航时于页面 JS 前执行）
  async preScript(targetId, js) {
    return this.fetch(`/preScript?target=${targetId}`, {
      method: 'POST', body: js,
    });
  }
}
