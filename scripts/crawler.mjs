#!/usr/bin/env node
/**
 * crawler.mjs — anyreach 爬虫执行器 V1
 *
 * 接收 URL 列表，并发提取内容，NDJSON 输出。
 * 支持 user mode（附着用户 Chrome）和 managed mode（独立 Chrome 实例）。
 *
 * 用法：
 *   node scripts/crawler.mjs --urls urls.txt [--concurrency 3] [--mode managed]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowser } from '../lib/browser-provider.mjs';
import { runAdapter, checkUrl } from './adapter-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- 参数解析 ---
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    urls: null,           // URL 列表文件路径
    concurrency: 3,       // 并发 worker 数
    delay: 1000,          // 请求间隔 ms
    timeout: 30000,       // 单页超时 ms
    retry: 2,             // 失败重试次数
    mode: 'managed',      // user | managed
    headless: true,       // managed mode 是否无头
    copyCookies: 'auto',  // auto | true | false
    output: null,         // 输出文件路径（默认 stdout）
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--urls':        opts.urls = args[++i]; break;
      case '--concurrency': opts.concurrency = parseInt(args[++i]) || 3; break;
      case '--delay':       opts.delay = parseInt(args[++i]) || 1000; break;
      case '--timeout':     opts.timeout = parseInt(args[++i]) || 30000; break;
      case '--retry':       opts.retry = parseInt(args[++i]) || 2; break;
      case '--mode':        opts.mode = args[++i]; break;
      case '--headless':    opts.headless = args[i + 1] === 'false' ? (i++, false) : true; break;
      case '--no-headless': opts.headless = false; break;
      case '--copy-cookies': opts.copyCookies = args[++i]; break;
      case '--output':      opts.output = args[++i]; break;
      case '--help': case '-h': printUsage(); process.exit(0);
    }
  }
  return opts;
}

function printUsage() {
  console.error(`
anyreach crawler v1

用法: node scripts/crawler.mjs --urls <file> [options]

参数:
  --urls <file>            URL 列表文件，每行一个（必需）
  --concurrency <n>        并发 worker 数 (默认 3)
  --delay <ms>             请求间隔 (默认 1000)
  --timeout <ms>           单页超时 (默认 30000)
  --retry <n>              失败重试次数 (默认 2)
  --mode <user|managed>    浏览器模式 (默认 managed)
  --no-headless            显示浏览器窗口 (仅 managed mode)
  --copy-cookies <auto|true|false>  Cookie 移植 (默认 auto)
  --output <file>          输出文件 (默认 stdout)
`.trim());
}

// --- URL 列表读取 ---
function readUrlList(filePath) {
  if (!filePath) {
    console.error('错误: 请指定 --urls <file>');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`错误: 文件不存在: ${filePath}`);
    process.exit(1);
  }
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// --- 轻量 HTTP helper（不依赖 ProxyClient） ---
async function proxyFetch(proxyBase, path, opts = {}) {
  const res = await fetch(`${proxyBase}${path}`, opts);
  return res.json();
}

// --- Cookie 移植 ---
async function transplantCookies(userProxyBase, managedProxyBase) {
  // 通过浏览器级 CDP 命令导出所有 cookie
  const cookies = await proxyFetch(userProxyBase, '/cdp', {
    method: 'POST',
    body: JSON.stringify({ method: 'Storage.getCookies' }),
  });

  if (cookies.error) {
    // fallback: 用 Network.getAllCookies（旧版 Chrome 兼容）
    const fallback = await proxyFetch(userProxyBase, '/cdp', {
      method: 'POST',
      body: JSON.stringify({ method: 'Network.getAllCookies' }),
    });
    if (fallback.error) {
      console.error(`[crawler] cookie 导出失败: ${fallback.error}`);
      return 0;
    }
    return await injectCookies(managedProxyBase, fallback.cookies || []);
  }

  return await injectCookies(managedProxyBase, cookies.cookies || []);
}

// 向 managed Chrome 注入 cookie
async function injectCookies(managedProxyBase, cookies) {
  if (!cookies.length) return 0;

  // 开一个临时 tab 用于注入
  const { targetId } = await proxyFetch(managedProxyBase, '/new?url=' + encodeURIComponent('about:blank'));

  let injected = 0;
  for (const cookie of cookies) {
    // setCookie 需要的字段
    const params = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      httpOnly: cookie.httpOnly || false,
      secure: cookie.secure || false,
      sameSite: cookie.sameSite || 'Lax',
    };
    // 保留过期时间
    if (cookie.expires && cookie.expires > 0) {
      params.expires = cookie.expires;
    }

    try {
      await proxyFetch(managedProxyBase, `/setCookie?target=${targetId}`, {
        method: 'POST',
        body: JSON.stringify(params),
      });
      injected++;
    } catch { /* 单个 cookie 注入失败不中断 */ }
  }

  // 关闭临时 tab
  await proxyFetch(managedProxyBase, `/close?target=${targetId}`).catch(() => {});

  return injected;
}

// --- 并发池 ---
async function runPool(items, concurrency, worker) {
  let index = 0;
  const total = items.length;
  const next = async () => {
    while (index < total) {
      const i = index++;
      await worker(items[i], i, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => next()));
}

// --- 带超时的 Promise ---
function withTimeout(promise, ms, url) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`超时 (${ms}ms): ${url}`)), ms)
    ),
  ]);
}

// --- extractText fallback（无 adapter 时使用） ---
async function fallbackExtract(url, proxyBase, timeoutMs) {
  const { targetId } = await proxyFetch(proxyBase, '/new?url=' + encodeURIComponent(url));

  try {
    // 等页面加载完
    await new Promise(r => setTimeout(r, 2000));
    const info = await proxyFetch(proxyBase, `/info?target=${targetId}`);
    const textResult = await proxyFetch(proxyBase, `/extractText?target=${targetId}`, {
      method: 'POST',
      body: JSON.stringify({ scroll: true }),
    });

    return {
      adapter: 'none',
      pageType: 'generic',
      title: info.title || '',
      url: info.url || url,
      text: textResult.text || '',
      length: textResult.length || 0,
    };
  } finally {
    await proxyFetch(proxyBase, `/close?target=${targetId}`).catch(() => {});
  }
}

// --- NDJSON 输出 ---
function createOutput(filePath) {
  if (filePath) {
    const stream = fs.createWriteStream(filePath, { flags: 'w' });
    return {
      write: (obj) => stream.write(JSON.stringify(obj) + '\n'),
      close: () => stream.end(),
    };
  }
  return {
    write: (obj) => process.stdout.write(JSON.stringify(obj) + '\n'),
    close: () => {},
  };
}

// --- 日志（输出到 stderr，不干扰 NDJSON） ---
function log(msg) {
  process.stderr.write(`[crawler] ${msg}\n`);
}

// --- 主流程 ---
async function main() {
  const opts = parseArgs();
  const urls = readUrlList(opts.urls);

  if (urls.length === 0) {
    log('URL 列表为空');
    process.exit(0);
  }

  log(`共 ${urls.length} 个 URL，并发 ${opts.concurrency}，模式 ${opts.mode}`);

  // 启动浏览器
  const browser = await createBrowser({
    mode: opts.mode,
    headless: opts.headless,
  });

  log(`浏览器就绪 (${browser.mode} mode, proxy port ${browser.proxyPort})`);

  // 注册退出清理
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    log('正在清理...');
    await browser.close();
  };
  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
  process.on('SIGTERM', async () => { await cleanup(); process.exit(143); });

  try {
    // Cookie 移植（仅 managed mode）
    if (browser.mode === 'managed' && opts.copyCookies !== 'false') {
      const shouldCopy = opts.copyCookies === 'true' || opts.copyCookies === 'auto';
      if (shouldCopy) {
        const userProxyPort = parseInt(process.env.CDP_PROXY_PORT) || 3456;
        const userProxyBase = `http://127.0.0.1:${userProxyPort}`;

        try {
          // 检测用户 proxy 是否在线
          const health = await fetch(`${userProxyBase}/health`, {
            signal: AbortSignal.timeout(2000)
          });
          if (health.ok) {
            log('正在从用户 Chrome 移植 cookie...');
            const count = await transplantCookies(userProxyBase, browser.proxyBase);
            log(`cookie 移植完成: ${count} 个`);
          } else if (opts.copyCookies === 'true') {
            throw new Error('用户 Chrome proxy 不可用');
          } else {
            log('用户 Chrome proxy 未检测到，跳过 cookie 移植');
          }
        } catch (e) {
          if (opts.copyCookies === 'true') {
            throw new Error(`cookie 移植失败: ${e.message}`);
          }
          log(`cookie 移植跳过: ${e.message}`);
        }
      }
    }

    // 输出
    const output = createOutput(opts.output);
    let successCount = 0;
    let errorCount = 0;

    // 并发爬取
    await runPool(urls, opts.concurrency, async (url, index, total) => {
      const startTime = Date.now();
      log(`[${index + 1}/${total}] ${url}`);

      let lastError = null;
      // 重试循环
      for (let attempt = 0; attempt <= opts.retry; attempt++) {
        if (attempt > 0) {
          log(`  重试 ${attempt}/${opts.retry}: ${url}`);
        }

        try {
          // 先尝试 adapter 路径
          const result = await withTimeout(
            runAdapter(url, { proxyPort: browser.proxyPort }),
            opts.timeout,
            url
          );

          const record = {
            url,
            status: 'ok',
            adapter: result.adapter || 'unknown',
            timestamp: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            data: result,
          };
          output.write(record);
          successCount++;
          lastError = null;
          break;

        } catch (e) {
          // 无 adapter → fallback 到 extractText
          if (e.code === 'NO_ADAPTER') {
            try {
              const result = await withTimeout(
                fallbackExtract(url, browser.proxyBase, opts.timeout),
                opts.timeout,
                url
              );

              const record = {
                url,
                status: 'ok',
                adapter: 'none',
                timestamp: new Date().toISOString(),
                duration_ms: Date.now() - startTime,
                data: result,
              };
              output.write(record);
              successCount++;
              lastError = null;
              break;

            } catch (fallbackErr) {
              lastError = fallbackErr;
            }
          } else {
            lastError = e;
          }
        }
      }

      // 所有重试都失败
      if (lastError) {
        const record = {
          url,
          status: 'error',
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - startTime,
          error: lastError.message,
        };
        output.write(record);
        errorCount++;
        log(`  失败: ${lastError.message}`);
      }

      // 请求间隔
      if (opts.delay > 0 && index < total - 1) {
        await new Promise(r => setTimeout(r, opts.delay));
      }
    });

    output.close();
    log(`完成: ${successCount} 成功, ${errorCount} 失败, 共 ${urls.length} 个 URL`);

  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error(`[crawler] 致命错误: ${e.message}`);
  process.exit(1);
});
