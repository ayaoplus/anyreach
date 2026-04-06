/**
 * browser-provider.mjs — 双模式浏览器管理
 *
 * createBrowser({ mode, headless, userDataDir })
 *   → { proxyBase, proxyPort, close() }
 *
 * user mode: 附着现有 CDP Proxy
 * managed mode: 启动独立 Chrome + CDP Proxy
 */

import { spawn, fork } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PROXY_SCRIPT = path.resolve(__dirname, '..', 'scripts', 'cdp-proxy.mjs');

// macOS Chrome 路径（优先级顺序）
const CHROME_PATHS_MACOS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

// 查找 Chrome 可执行文件
function findChromeBinary() {
  const paths = process.platform === 'darwin' ? CHROME_PATHS_MACOS : [];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome。请安装 Google Chrome 或设置路径。');
}

// 获取一个空闲端口
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// 轮询 HTTP 端点直到就绪
async function waitForReady(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return true;
    } catch { /* 还没起来，继续轮询 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`等待 ${url} 超时 (${timeoutMs}ms)`);
}

// 创建浏览器实例
// opts.mode: 'user' | 'managed'（默认 managed）
// opts.userProxyPort: user mode 下的 proxy 端口（默认 3456）
// opts.headless: managed mode 是否无头（默认 true）
// opts.userDataDir: managed mode 的 Chrome profile 目录（默认临时目录）
export async function createBrowser(opts = {}) {
  const mode = opts.mode || 'managed';

  if (mode === 'user') {
    return createUserBrowser(opts);
  }
  return createManagedBrowser(opts);
}

// User mode：附着现有 proxy
async function createUserBrowser(opts) {
  const proxyPort = opts.userProxyPort || parseInt(process.env.CDP_PROXY_PORT) || 3456;
  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  try {
    await waitForReady(`${proxyBase}/health`, 5000);
  } catch {
    throw new Error(`User mode 需要已运行的 CDP Proxy (port ${proxyPort})。请先启动 proxy。`);
  }

  return {
    proxyBase,
    proxyPort,
    mode: 'user',
    close: async () => { /* user mode 不关闭用户的 proxy */ },
  };
}

// Managed mode：启动独立 Chrome + CDP Proxy
async function createManagedBrowser(opts) {
  const chromeBin = findChromeBinary();
  const headless = opts.headless !== false; // 默认 true
  const [chromePort, proxyPort] = await Promise.all([getFreePort(), getFreePort()]);

  // 创建临时 profile 目录
  const userDataDir = opts.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'anyreach-crawler-'));
  const shouldCleanup = !opts.userDataDir; // 只清理自动创建的临时目录

  // 启动 Chrome
  const chromeArgs = [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--mute-audio',
  ];
  if (headless) chromeArgs.push('--headless=new');

  const chromeProc = spawn(chromeBin, chromeArgs, {
    stdio: 'ignore',
    detached: false,
  });

  chromeProc.on('error', (err) => {
    console.error(`[browser-provider] Chrome 启动失败: ${err.message}`);
  });

  // 等待 Chrome 调试端口就绪
  const chromeReady = await waitForChromePort(chromePort, 10000).catch((err) => {
    chromeProc.kill();
    throw err;
  });

  // 启动 CDP Proxy（fork 子进程）
  const proxyProc = fork(CDP_PROXY_SCRIPT, [], {
    env: {
      ...process.env,
      CDP_PROXY_PORT: String(proxyPort),
      CDP_CHROME_PORT: String(chromePort),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  // proxy 日志输出到 stderr（带前缀）
  proxyProc.stdout?.on('data', (d) => process.stderr.write(`[proxy:${proxyPort}] ${d}`));
  proxyProc.stderr?.on('data', (d) => process.stderr.write(`[proxy:${proxyPort}] ${d}`));

  const proxyBase = `http://127.0.0.1:${proxyPort}`;

  // 等待 proxy 就绪
  await waitForReady(`${proxyBase}/health`, 10000).catch((err) => {
    proxyProc.kill();
    chromeProc.kill();
    throw err;
  });

  console.error(`[browser-provider] managed browser ready (chrome:${chromePort} proxy:${proxyPort}${headless ? ' headless' : ''})`);

  // 返回接口
  return {
    proxyBase,
    proxyPort,
    mode: 'managed',
    chromePort,
    userDataDir,
    close: async () => {
      // 先关 proxy 再关 Chrome
      try { proxyProc.kill(); } catch {}
      try { chromeProc.kill(); } catch {}

      // 清理临时目录
      if (shouldCleanup) {
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

// 等待 Chrome 调试端口可达
async function waitForChromePort(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.createConnection(port, '127.0.0.1');
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
      socket.once('error', () => { clearTimeout(timer); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Chrome 调试端口 ${port} 未就绪 (${timeoutMs}ms)`);
}
