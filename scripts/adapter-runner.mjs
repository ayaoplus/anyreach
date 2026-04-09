#!/usr/bin/env node
// AnyReach 站点适配器调度器
// 三层递进：.mjs 代码适配器 → .md prompt 提示 → 通用模式
//
// 用法：
//   node adapter-runner.mjs check <url>    — 检查匹配层级（adapter/hint/none）
//   node adapter-runner.mjs run <url>      — 运行代码适配器提取内容
//   node adapter-runner.mjs hint <url>     — 返回 .md 提示内容
//   node adapter-runner.mjs list           — 列出所有已安装适配器和提示

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture as captureLogin, waitForLogin } from '../lib/login-detector.mjs';
import { ProxyClient } from '../lib/proxy-client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTERS_DIR = path.join(ROOT, 'adapters');

// Remote registry for dynamic adapter download
const REGISTRY_URL = process.env.ANYREACH_REGISTRY
  || 'https://raw.githubusercontent.com/ayaoplus/anyreach/main/registry.json';
const RAW_BASE = 'https://raw.githubusercontent.com/ayaoplus/anyreach/main/';
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

// --- 适配器和提示加载 ---

// 从 hostname 提取匹配用的域名关键词（去掉 www. 等前缀）
function extractDomain(hostname) {
  return hostname.replace(/^www\./, '');
}

// 扫描 .mjs 代码适配器
async function loadAdapters() {
  const adapters = [];
  if (!fs.existsSync(ADAPTERS_DIR)) return adapters;
  for (const file of fs.readdirSync(ADAPTERS_DIR)) {
    if (!file.endsWith('.mjs') || file.startsWith('_')) continue;
    try {
      const mod = await import(path.join(ADAPTERS_DIR, file));
      if (mod.default?.domains) {
        adapters.push({ file, type: 'adapter', ...mod.default });
      }
    } catch (e) {
      console.error(`[AnyReach] adapter load failed ${file}: ${e.message}`);
    }
  }
  return adapters;
}

// 扫描 .md prompt 提示文件
// 格式：frontmatter 中包含 domain 和 aliases，正文为提示内容
function loadHints() {
  const hints = [];
  if (!fs.existsSync(ADAPTERS_DIR)) return hints;
  for (const file of fs.readdirSync(ADAPTERS_DIR)) {
    if (!file.endsWith('.md') || file.startsWith('_')) continue;
    try {
      const raw = fs.readFileSync(path.join(ADAPTERS_DIR, file), 'utf8');
      // 解析 frontmatter
      const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
      if (!fmMatch) continue;
      const fm = fmMatch[1];
      const body = fmMatch[2].trim();
      // 提取 domain
      const domainMatch = fm.match(/^domain:\s*(.+)/m);
      if (!domainMatch) continue;
      const domain = domainMatch[1].trim();
      // 提取 aliases
      const aliasMatch = fm.match(/^aliases:\s*\[([^\]]*)\]/m);
      const aliases = aliasMatch
        ? aliasMatch[1].split(',').map(s => s.trim()).filter(Boolean)
        : [];
      hints.push({ file, type: 'hint', domain, aliases, body });
    } catch { /* skip unreadable files */ }
  }
  return hints;
}

// --- 远程注册表 ---

let _registryCache = null;
let _registryCacheTime = 0;
const REGISTRY_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchRegistry() {
  if (_registryCache && (Date.now() - _registryCacheTime) < REGISTRY_TTL) {
    return _registryCache;
  }
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return _registryCache; // return stale cache on fetch failure
    _registryCache = await res.json();
    _registryCacheTime = Date.now();
    return _registryCache;
  } catch {
    return _registryCache; // return stale cache on network error
  }
}

// Check if hostname matches any adapter in the remote registry
async function checkRemoteRegistry(hostname) {
  const reg = await fetchRegistry();
  if (!reg?.adapters) return null;
  for (const [name, entry] of Object.entries(reg.adapters)) {
    for (const d of entry.domains || []) {
      if (hostname === d || hostname.endsWith('.' + d)) {
        return { name, ...entry };
      }
    }
  }
  return null;
}

// Download adapter files from remote and cache locally
async function downloadAdapter(remoteEntry) {
  const files = [...(remoteEntry.files || [])];

  // also download shared utils if not present locally
  const reg = await fetchRegistry();
  if (reg?.shared) {
    for (const sf of reg.shared) {
      const localPath = path.join(ROOT, sf);
      if (!fs.existsSync(localPath)) files.push(sf);
    }
  }

  const results = [];
  for (const file of files) {
    const url = RAW_BASE + file;
    const localPath = path.join(ROOT, file);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { results.push({ file, error: `HTTP ${res.status}` }); continue; }
      const content = await res.text();
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, content, 'utf8');
      results.push({ file, saved: localPath });
    } catch (e) {
      results.push({ file, error: e.message });
    }
  }
  return results;
}

// 根据 URL 匹配：先找 .mjs 适配器，再找 .md 提示
async function matchUrl(url) {
  const hostname = extractDomain(new URL(url).hostname);

  // 第一层：代码适配器
  const adapters = await loadAdapters();
  for (const adapter of adapters) {
    for (const d of adapter.domains) {
      if (hostname === d || hostname.endsWith('.' + d)) {
        return { level: 'adapter', adapter };
      }
    }
  }

  // 第二层：prompt 提示
  const hints = loadHints();
  for (const hint of hints) {
    const patterns = [hint.domain, ...hint.aliases];
    for (const p of patterns) {
      if (hostname === p || hostname.endsWith('.' + p) || hostname.includes(p)) {
        return { level: 'hint', hint };
      }
    }
  }

  // 第三层：远程注册表 — 检查是否有可下载的适配器
  const remote = await checkRemoteRegistry(hostname);
  if (remote) {
    return { level: 'remote', remote };
  }

  // 第四层：通用模式
  return { level: 'none' };
}

// --- 公开 API ---

// 检查 URL 的匹配层级（adapter → hint → remote → none）
export async function checkUrl(url) {
  return matchUrl(url);
}

// 从远程下载适配器到本地
export { downloadAdapter };

// 获取 .md 提示内容
export async function getHint(url) {
  const match = await matchUrl(url);
  if (match.level === 'hint') return match.hint.body;
  return null;
}

// 在已有 tab 上执行适配器（不创建/关闭 tab，供内部复用）
async function _executeAdapter(proxy, targetId, url, opts, adapter) {
  const pageType = adapter.detect ? adapter.detect(url) : 'default';
  if (!adapter.extract) {
    return { adapter: adapter.name, pageType, error: 'adapter has no extract method' };
  }
  const ctx = { url, pageType, ...opts };
  delete ctx.proxyPort;
  const result = await adapter.extract(proxy, targetId, ctx);
  return { adapter: adapter.name, pageType, ...result };
}

// 运行代码适配器（自动下载远程适配器）
export async function runAdapter(url, opts = {}) {
  let match = await matchUrl(url);

  // auto-download remote adapter if available
  if (match.level === 'remote') {
    console.error(`[AnyReach] downloading adapter: ${match.remote.name}...`);
    await downloadAdapter(match.remote);
    match = await matchUrl(url); // re-match after download
  }

  if (match.level !== 'adapter') {
    const err = new Error('no_adapter');
    err.code = 'NO_ADAPTER';
    throw err;
  }

  const { adapter } = match;
  const proxy = new ProxyClient(opts.proxyPort || PROXY_PORT);
  const targetId = await proxy.newTab(url);
  let keepTabOpen = false;

  try {
    // 等页面基本就绪，检查登录墙（capture 内部已调用 detect，避免重复 eval）
    await new Promise(r => setTimeout(r, 1500));
    const loginInfo = await captureLogin(proxy, targetId);
    if (loginInfo) {
      keepTabOpen = true; // 保留 tab，等用户登录后 retry
      return {
        error: 'login_required',
        loginType: loginInfo.type,
        screenshotPath: loginInfo.screenshotPath || null,
        fields: loginInfo.fields || null,
        message: loginInfo.message || '需要登录',
        targetId,
        hint: `登录后运行: node adapter-runner.mjs retry-after-login ${targetId} "${url}"`,
      };
    }

    return await _executeAdapter(proxy, targetId, url, opts, adapter);
  } finally {
    if (!keepTabOpen) await proxy.close(targetId).catch(() => {});
  }
}

// --- CLI 入口 ---
async function main() {
  const [,, command, arg] = process.argv;

  if (command === 'list') {
    const adapters = await loadAdapters();
    const hints = loadHints();
    if (adapters.length === 0 && hints.length === 0) {
      console.log('No adapters or hints installed.');
      return;
    }
    if (adapters.length > 0) {
      console.log('Adapters (.mjs):');
      for (const a of adapters) {
        console.log(`  ${a.name} — ${a.domains.join(', ')} — ${a.description || ''}`);
      }
    }
    if (hints.length > 0) {
      console.log('Hints (.md):');
      for (const h of hints) {
        const aliases = h.aliases.length > 0 ? ` (aliases: ${h.aliases.join(', ')})` : '';
        console.log(`  ${h.domain}${aliases} — ${h.file}`);
      }
    }
    return;
  }

  if (command === 'check') {
    if (!arg) { console.error('Usage: adapter-runner.mjs check <url>'); process.exit(1); }
    const match = await matchUrl(arg);
    const out = match.level === 'adapter'
      ? { level: 'adapter', name: match.adapter.name, domains: match.adapter.domains }
      : match.level === 'hint'
        ? { level: 'hint', domain: match.hint.domain, file: match.hint.file }
        : match.level === 'remote'
          ? { level: 'remote', name: match.remote.name, domains: match.remote.domains }
          : { level: 'none' };
    console.log(JSON.stringify(out));
    return;
  }

  if (command === 'run') {
    if (!arg) { console.error('Usage: adapter-runner.mjs run <url> [--ctx <json>]'); process.exit(1); }
    // --ctx '{"maxPages":10,"limit":300}' 传额外参数给适配器
    const ctxIdx = process.argv.indexOf('--ctx');
    const extraCtx = ctxIdx !== -1 ? JSON.parse(process.argv[ctxIdx + 1]) : {};
    try {
      const result = await runAdapter(arg, extraCtx);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      if (e.code === 'NO_ADAPTER') {
        console.log(JSON.stringify({ error: 'no_adapter', url: arg }));
      } else {
        console.error('Error:', e.message);
        process.exit(1);
      }
    }
    return;
  }

  if (command === 'hint') {
    if (!arg) { console.error('Usage: adapter-runner.mjs hint <url>'); process.exit(1); }
    const body = await getHint(arg);
    if (body) {
      console.log(body);
    } else {
      console.log(JSON.stringify({ hint: null }));
    }
    return;
  }

  // retry-after-login <targetId> <url>
  // 在用户完成登录后，等待登录墙消失，然后在同一个 tab 上重跑 adapter
  if (command === 'retry-after-login') {
    const retryTargetId = arg;
    const retryUrl = process.argv[4];
    if (!retryTargetId || !retryUrl) {
      console.error('Usage: adapter-runner.mjs retry-after-login <targetId> <url>');
      process.exit(1);
    }

    const proxy = new ProxyClient(PROXY_PORT);
    console.error('[AnyReach] 等待登录完成（最长 3 分钟）...');
    const { success, elapsed } = await waitForLogin(proxy, retryTargetId);

    if (!success) {
      console.log(JSON.stringify({ error: 'login_timeout', hint: '登录超时（3 分钟），请重新运行' }));
      await proxy.close(retryTargetId).catch(() => {});
      return;
    }

    console.error(`[AnyReach] 登录成功（${Math.round(elapsed / 1000)}s），重新提取...`);

    // 导航到目标 URL（刷新已登录的状态）
    await proxy.navigate(retryTargetId, retryUrl);
    await new Promise(r => setTimeout(r, 2000));

    let match = await matchUrl(retryUrl);
    if (match.level === 'remote') {
      await downloadAdapter(match.remote);
      match = await matchUrl(retryUrl);
    }

    try {
      if (match.level !== 'adapter') {
        console.log(JSON.stringify({ error: 'no_adapter', url: retryUrl }));
        return;
      }
      const ctxIdx = process.argv.indexOf('--ctx');
      const extraCtx = ctxIdx !== -1 ? JSON.parse(process.argv[ctxIdx + 1]) : {};
      const result = await _executeAdapter(proxy, retryTargetId, retryUrl, extraCtx, match.adapter);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await proxy.close(retryTargetId).catch(() => {});
    }
    return;
  }

  if (command === 'download') {
    if (!arg) { console.error('Usage: adapter-runner.mjs download <url>'); process.exit(1); }
    const match = await matchUrl(arg);
    if (match.level === 'adapter') {
      console.log(`Already installed: ${match.adapter.name}`);
    } else if (match.level === 'remote') {
      console.log(`Downloading: ${match.remote.name}...`);
      const results = await downloadAdapter(match.remote);
      for (const r of results) {
        console.log(r.error ? `  FAIL ${r.file}: ${r.error}` : `  OK ${r.saved}`);
      }
    } else {
      console.log('No adapter available for this URL (local or remote).');
    }
    return;
  }

  console.log('AnyReach Adapter Runner');
  console.log('');
  console.log('Usage:');
  console.log('  node adapter-runner.mjs list                          List installed adapters and hints');
  console.log('  node adapter-runner.mjs check <url>                   Check match level (adapter/hint/remote/none)');
  console.log('  node adapter-runner.mjs run <url> [--ctx <json>]      Run adapter (auto-downloads if remote)');
  console.log('  node adapter-runner.mjs hint <url>                    Get .md hint content for URL');
  console.log('  node adapter-runner.mjs download <url>                Download remote adapter to local');
  console.log('  node adapter-runner.mjs retry-after-login <id> <url>  Wait for login then re-run adapter');
}

// 仅在 CLI 直接调用时运行 main
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
