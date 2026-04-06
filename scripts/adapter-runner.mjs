#!/usr/bin/env node
// AnyReach 站点适配器调度器
// 根据 URL 匹配适配器，执行提取/交互操作
// 用法：
//   node adapter-runner.mjs check <url>    — 检查是否有适配器
//   node adapter-runner.mjs run <url>      — 运行适配器提取内容
//   node adapter-runner.mjs list           — 列出已安装适配器

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS_DIR = path.join(ROOT, 'adapters');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

// --- Proxy 客户端（供适配器使用） ---
class ProxyClient {
  constructor(port) {
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
  }

  async _fetch(path, opts = {}) {
    const res = await fetch(`${this.base}${path}`, opts);
    return res.json();
  }

  // 创建新 tab，返回 targetId
  async newTab(url) {
    const r = await this._fetch(`/new?url=${encodeURIComponent(url)}`);
    return r.targetId;
  }

  // 关闭 tab
  async close(targetId) {
    return this._fetch(`/close?target=${targetId}`);
  }

  // 页面信息
  async info(targetId) {
    return this._fetch(`/info?target=${targetId}`);
  }

  // 执行 JS，返回值
  async eval(targetId, js) {
    const r = await this._fetch(`/eval?target=${targetId}`, {
      method: 'POST', body: js,
    });
    if (r.error) throw new Error(r.error);
    return r.value;
  }

  // 导航
  async navigate(targetId, url) {
    return this._fetch(`/navigate?target=${targetId}&url=${encodeURIComponent(url)}`);
  }

  // 滚动
  async scroll(targetId, opts = {}) {
    const params = new URLSearchParams({ target: targetId, ...opts });
    return this._fetch(`/scroll?${params}`);
  }

  // 截图
  async screenshot(targetId, filePath) {
    return this._fetch(`/screenshot?target=${targetId}&file=${encodeURIComponent(filePath)}`);
  }

  // JS 点击
  async click(targetId, selector) {
    return this._fetch(`/click?target=${targetId}`, {
      method: 'POST', body: selector,
    });
  }

  // 真实鼠标点击
  async clickAt(targetId, selector) {
    return this._fetch(`/clickAt?target=${targetId}`, {
      method: 'POST', body: selector,
    });
  }

  // 提取文本（增强端点）
  async extractText(targetId, opts = {}) {
    return this._fetch(`/extractText?target=${targetId}`, {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  }

  // 填写表单
  async fill(targetId, fields) {
    return this._fetch(`/fill?target=${targetId}`, {
      method: 'POST',
      body: JSON.stringify(fields),
    });
  }

  // 等待元素
  async waitFor(targetId, selector, timeout = 10000) {
    return this._fetch(`/waitFor?target=${targetId}&selector=${encodeURIComponent(selector)}&timeout=${timeout}`);
  }

  // 注入 Cookie
  async setCookie(targetId, cookie) {
    return this._fetch(`/setCookie?target=${targetId}`, {
      method: 'POST',
      body: JSON.stringify(cookie),
    });
  }

  // 获取 Cookie
  async getCookies(targetId, domain) {
    const params = domain ? `&domain=${domain}` : '';
    return this._fetch(`/getCookies?target=${targetId}${params}`);
  }
}

// --- 适配器加载 ---

// 扫描本地适配器目录，返回 { domain, module } 列表
async function loadAdapters() {
  const adapters = [];
  if (!fs.existsSync(ADAPTERS_DIR)) return adapters;

  for (const file of fs.readdirSync(ADAPTERS_DIR)) {
    if (!file.endsWith('.mjs') || file.startsWith('_')) continue;
    try {
      const mod = await import(path.join(ADAPTERS_DIR, file));
      if (mod.default?.domains) {
        adapters.push({ file, ...mod.default });
      }
    } catch (e) {
      console.error(`[AnyReach] 适配器加载失败 ${file}: ${e.message}`);
    }
  }
  return adapters;
}

// 根据 URL 匹配适配器
async function matchAdapter(url) {
  const hostname = new URL(url).hostname;
  const adapters = await loadAdapters();
  for (const adapter of adapters) {
    for (const domain of adapter.domains) {
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return adapter;
      }
    }
  }
  return null;
}

// --- 公开 API ---

// 供 CDP Proxy /adapter 端点调用
export async function runAdapter(url, opts = {}) {
  const adapter = await matchAdapter(url);
  if (!adapter) {
    const err = new Error('no_adapter');
    err.code = 'NO_ADAPTER';
    throw err;
  }

  const proxy = new ProxyClient(opts.proxyPort || PROXY_PORT);

  // 创建 tab
  const targetId = await proxy.newTab(url);

  try {
    // 检测页面类型
    const pageType = adapter.detect ? adapter.detect(url) : 'default';

    // 执行提取
    if (adapter.extract) {
      const result = await adapter.extract(proxy, targetId, { url, pageType });
      return { adapter: adapter.name, pageType, ...result };
    }

    return { adapter: adapter.name, pageType, error: '适配器未定义 extract 方法' };
  } finally {
    // 清理 tab
    await proxy.close(targetId).catch(() => {});
  }
}

// --- CLI 入口 ---
async function main() {
  const [,, command, arg] = process.argv;

  if (command === 'list') {
    const adapters = await loadAdapters();
    if (adapters.length === 0) {
      console.log('暂无已安装的适配器');
    } else {
      for (const a of adapters) {
        console.log(`  ${a.name} — ${a.domains.join(', ')} — ${a.description || ''}`);
      }
    }
    return;
  }

  if (command === 'check') {
    if (!arg) { console.error('用法: adapter-runner.mjs check <url>'); process.exit(1); }
    const adapter = await matchAdapter(arg);
    if (adapter) {
      console.log(JSON.stringify({ has_adapter: true, name: adapter.name, domains: adapter.domains }));
    } else {
      console.log(JSON.stringify({ has_adapter: false }));
    }
    return;
  }

  if (command === 'run') {
    if (!arg) { console.error('用法: adapter-runner.mjs run <url>'); process.exit(1); }
    try {
      const result = await runAdapter(arg);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      if (e.code === 'NO_ADAPTER') {
        console.log(JSON.stringify({ error: 'no_adapter', url: arg }));
      } else {
        console.error('错误:', e.message);
        process.exit(1);
      }
    }
    return;
  }

  console.log('AnyReach Adapter Runner');
  console.log('用法:');
  console.log('  node adapter-runner.mjs list              列出已安装适配器');
  console.log('  node adapter-runner.mjs check <url>       检查 URL 是否有适配器');
  console.log('  node adapter-runner.mjs run <url>         运行适配器提取内容');
}

// 仅在 CLI 直接调用时运行 main
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
