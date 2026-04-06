#!/usr/bin/env node
// AnyReach 环境检查 + 确保 CDP Proxy 就绪

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_SCRIPT = path.join(ROOT, 'scripts', 'cdp-proxy.mjs');
const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

// --- Node.js 版本 ---
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  const ver = `v${process.versions.node}`;
  console.log(major >= 22 ? `node: ok (${ver})` : `node: warn (${ver}, 建议 22+)`);
}

// --- TCP 探测 ---
function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// --- Chrome 端口检测 ---
function activePortFiles() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || '';
  const map = {
    darwin: [
      path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
    ],
    linux: [
      path.join(home, '.config/google-chrome/DevToolsActivePort'),
      path.join(home, '.config/chromium/DevToolsActivePort'),
    ],
    win32: [
      path.join(local, 'Google/Chrome/User Data/DevToolsActivePort'),
      path.join(local, 'Chromium/User Data/DevToolsActivePort'),
    ],
  };
  return map[os.platform()] || [];
}

async function detectChromePort() {
  for (const f of activePortFiles()) {
    try {
      const port = parseInt(fs.readFileSync(f, 'utf8').trim().split(/\r?\n/)[0], 10);
      if (port > 0 && port < 65536 && await probePort(port)) return port;
    } catch {}
  }
  for (const port of [9222, 9229, 9333]) {
    if (await probePort(port)) return port;
  }
  return null;
}

// --- Proxy 管理 ---
async function httpGetJson(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then(async r => { try { return JSON.parse(await r.text()); } catch { return null; } })
    .catch(() => null);
}

function startProxyDetached() {
  const logFile = path.join(os.tmpdir(), 'anyreach-proxy.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    ...(os.platform() === 'win32' ? { windowsHide: true } : {}),
  });
  child.unref();
  fs.closeSync(logFd);
}

async function ensureProxy() {
  const url = `http://127.0.0.1:${PROXY_PORT}/targets`;

  // 已就绪
  const targets = await httpGetJson(url);
  if (Array.isArray(targets)) { console.log('proxy: ready'); return true; }

  // 启动并等待
  console.log('proxy: connecting...');
  startProxyDetached();
  await new Promise(r => setTimeout(r, 2000));

  for (let i = 1; i <= 15; i++) {
    const result = await httpGetJson(url, 8000);
    if (Array.isArray(result)) { console.log('proxy: ready'); return true; }
    if (i === 1) console.log('Chrome 可能有授权弹窗，请点击「允许」...');
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('连接超时，请检查 Chrome 调试设置');
  console.log(`  日志：${path.join(os.tmpdir(), 'anyreach-proxy.log')}`);
  return false;
}

// --- main ---
async function main() {
  checkNode();

  const chromePort = await detectChromePort();
  if (!chromePort) {
    console.log('chrome: not connected — 请打开 chrome://inspect/#remote-debugging 并勾选 Allow remote debugging');
    process.exit(1);
  }
  console.log(`chrome: ok (port ${chromePort})`);

  if (!await ensureProxy()) process.exit(1);
}

await main();
