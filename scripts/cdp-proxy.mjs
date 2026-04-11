#!/usr/bin/env node
// AnyReach CDP Proxy - 通过 HTTP API 操控用户日常 Chrome
// 基于 web-access CDP Proxy，增强版
// 要求：Chrome 已开启远程调试 / Node.js 22+（原生 WebSocket）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
let ws = null;
let cmdId = 0;
const pending = new Map();   // id -> { resolve, timer }
const sessions = new Map();  // targetId -> sessionId
const eventCollectors = new Map(); // collectorId -> { filter, events[], maxEvents }

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  WS = globalThis.WebSocket;
} else {
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[AnyReach] Node.js < 22 且未安装 ws 模块，请升级到 Node.js 22+ 或 npm install -g ws');
    process.exit(1);
  }
}

// --- Chrome 调试端口自动发现 ---
function getDevToolsActivePortPaths() {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
    ];
  } else if (platform === 'linux') {
    return [
      path.join(home, '.config/google-chrome/DevToolsActivePort'),
      path.join(home, '.config/chromium/DevToolsActivePort'),
    ];
  } else if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(local, 'Google/Chrome/User Data/DevToolsActivePort'),
      path.join(local, 'Chromium/User Data/DevToolsActivePort'),
    ];
  }
  return [];
}

// TCP 探测端口是否在监听（避免 WebSocket 触发 Chrome 安全弹窗）
function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function discoverChromePort() {
  // 优先读 DevToolsActivePort 文件
  for (const p of getDevToolsActivePortPaths()) {
    try {
      const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
      const port = parseInt(lines[0]);
      if (port > 0 && port < 65536 && await probePort(port)) {
        const wsPath = lines[1] || null;
        console.log(`[AnyReach] 从 DevToolsActivePort 发现端口: ${port}${wsPath ? ' (带 wsPath)' : ''}`);
        return { port, wsPath };
      }
    } catch { /* 文件不存在 */ }
  }
  // 回退扫描常用端口
  for (const port of [9222, 9229, 9333]) {
    if (await probePort(port)) {
      console.log(`[AnyReach] 扫描发现 Chrome 端口: ${port}`);
      return { port, wsPath: null };
    }
  }
  return null;
}

// --- WebSocket 连接管理 ---
let chromePort = null;
let chromeWsPath = null;
let connectingPromise = null;

async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;
  if (connectingPromise) return connectingPromise;

  if (!chromePort) {
    // 支持通过环境变量指定 Chrome 调试端口（managed browser mode 使用）
    if (process.env.CDP_CHROME_PORT) {
      const envPort = parseInt(process.env.CDP_CHROME_PORT);
      if (envPort > 0 && envPort < 65536 && await probePort(envPort)) {
        chromePort = envPort;
        console.log(`[AnyReach] 使用指定 Chrome 端口: ${chromePort}`);
      }
    }
    if (!chromePort) {
      const found = await discoverChromePort();
      if (!found) {
        throw new Error(
          'Chrome 未开启远程调试。请在 chrome://inspect/#remote-debugging 勾选 "Allow remote debugging"'
        );
      }
      chromePort = found.port;
      chromeWsPath = found.wsPath;
    }
  }

  let wsUrl;
  if (chromeWsPath) {
    wsUrl = `ws://127.0.0.1:${chromePort}${chromeWsPath}`;
  } else {
    // 从 /json/version 获取完整的 WebSocket URL（headless Chrome 需要带 browser UUID）
    try {
      const resp = await fetch(`http://127.0.0.1:${chromePort}/json/version`, {
        signal: AbortSignal.timeout(3000),
      });
      const info = await resp.json();
      wsUrl = info.webSocketDebuggerUrl || `ws://127.0.0.1:${chromePort}/devtools/browser`;
    } catch {
      wsUrl = `ws://127.0.0.1:${chromePort}/devtools/browser`;
    }
  }

  return connectingPromise = new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      connectingPromise = null;
      console.log(`[AnyReach] 已连接 Chrome (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      connectingPromise = null;
      ws = null;
      chromePort = null;
      chromeWsPath = null;
      reject(new Error(e.message || e.error?.message || '连接失败'));
    };
    const onClose = () => {
      ws = null;
      chromePort = null;
      chromeWsPath = null;
      sessions.clear();
      console.log('[AnyReach] 连接断开');
    };
    const onMessage = (evt) => {
      const raw = typeof evt === 'string' ? evt : (evt.data || evt);
      const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());

      // session 自动注册
      if (msg.method === 'Target.attachedToTarget') {
        sessions.set(msg.params.targetInfo.targetId, msg.params.sessionId);
      }
      // 拦截页面对调试端口的探测（反风控）
      if (msg.method === 'Fetch.requestPaused') {
        sendCDP('Fetch.failRequest', {
          requestId: msg.params.requestId,
          errorReason: 'ConnectionRefused',
        }, msg.params.sessionId).catch(() => {});
      }
      // Worker 自动注入：当 setAutoAttach + waitForDebugger 模式下，
      // 自动在新 Worker 上启用 Network 后恢复执行
      if (msg.method === 'Target.attachedToTarget' && msg.params?.waitingForDebugger) {
        const workerSid = msg.params.sessionId;
        sendCDP('Network.enable', {}, workerSid)
          .then(() => sendCDP('Runtime.runIfWaitingForDebugger', {}, workerSid))
          .catch(() => {});
      }
      // 通用事件收集器：将匹配的 CDP 事件存入队列
      if (msg.method) {
        for (const [, col] of eventCollectors) {
          if (col.filter && !msg.method.startsWith(col.filter)) continue;
          if (col.sessionId && msg.sessionId !== col.sessionId) continue;
          col.events.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
          if (col.events.length > (col.maxEvents || 500)) col.events.shift();
        }
      }
      // 匹配 pending 请求
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    }

    // 兼容原生 WebSocket 和 ws 模块
    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    }
  });
}

function sendCDP(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error('WebSocket 未连接'));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 命令超时: ' + method));
    }, 30000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
}

// 已启用端口拦截的 session
const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// 拦截页面对 Chrome 调试端口的探测请求
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* 不影响主流程 */ }
}

// --- 等待页面加载 ---
async function waitForLoad(sessionId, timeoutMs = 15000) {
  await sendCDP('Page.enable', {}, sessionId);
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(check);
      resolve(result);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const check = setInterval(async () => {
      try {
        const r = await sendCDP('Runtime.evaluate', {
          expression: 'document.readyState', returnByValue: true,
        }, sessionId);
        if (r.result?.result?.value === 'complete') done('complete');
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- 辅助：执行 JS 并返回值 ---
async function evalJS(sid, expression) {
  const resp = await sendCDP('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (resp.result?.exceptionDetails) {
    throw new Error(resp.result.exceptionDetails.text || 'JS 执行错误');
  }
  return resp.result?.result?.value;
}

// =============================================
// HTTP API 路由
// =============================================
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // --- 健康检查 ---
    if (pathname === '/health') {
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({ status: 'ok', connected, sessions: sessions.size, chromePort }));
      return;
    }

    await connect();

    // ==================== 基础端点（继承 web-access） ====================

    // GET /targets - 列出所有页面 tab
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const pages = resp.result.targetInfos.filter(t => t.type === 'page');
      res.end(JSON.stringify(pages, null, 2));
    }

    // GET /new?url=xxx - 创建新后台 tab（自动等待加载）
    else if (pathname === '/new') {
      const targetUrl = q.url || 'about:blank';
      const resp = await sendCDP('Target.createTarget', { url: targetUrl, background: true });
      const targetId = resp.result.targetId;
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await waitForLoad(sid);
        } catch { /* 非致命 */ }
      }
      res.end(JSON.stringify({ targetId }));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      res.end(JSON.stringify({ ok: true }));
    }

    // GET /navigate?target=xxx&url=yyy - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: q.url }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await evalJS(sid, 'history.back()');
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // GET /info?target=xxx - 页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const val = await evalJS(sid,
        'JSON.stringify({title:document.title,url:location.href,ready:document.readyState})');
      res.end(val || '{}');
    }

    // POST /eval?target=xxx - 执行任意 JS
    else if (pathname === '/eval') {
      const sid = await ensureSession(q.target);
      const expr = (await readBody(req)) || q.expr || 'document.title';
      try {
        const value = await evalJS(sid, expr);
        res.end(JSON.stringify({ value }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: e.message }));
      }
    }

    // POST /click?target=xxx - JS click（body 为 CSS 选择器）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) { res.statusCode = 400; res.end(JSON.stringify({ error: '需要 CSS 选择器' })); return; }
      const val = await evalJS(sid, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: '未找到元素: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`);
      if (val?.error) { res.statusCode = 400; }
      res.end(JSON.stringify(val));
    }

    // POST /clickAt?target=xxx - CDP 真实鼠标点击
    // 先激活 tab（后台 tab 的 Input 事件不生效），再发 mousePressed/mouseReleased
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) { res.statusCode = 400; res.end(JSON.stringify({ error: '需要 CSS 选择器' })); return; }
      // 激活 tab — CDP Input 事件仅在前台 tab 生效
      await sendCDP('Target.activateTarget', { targetId: q.target }).catch(() => {});
      const coord = await evalJS(sid, `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: '未找到元素: ' + ${JSON.stringify(selector)} };
        const r = el.getBoundingClientRect();
        const inViewport = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
        if (!inViewport) {
          el.scrollIntoView({ block: 'center' });
        }
        const r2 = el.getBoundingClientRect();
        return { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`);
      if (!coord || coord.error) { res.statusCode = 400; res.end(JSON.stringify(coord)); return; }
      await sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1 }, sid);
      await sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1 }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // POST /setFiles?target=xxx - 文件上传
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) { res.statusCode = 400; res.end(JSON.stringify({ error: '需要 selector 和 files' })); return; }
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: body.selector }, sid);
      if (!node.result?.nodeId) { res.statusCode = 400; res.end(JSON.stringify({ error: '未找到: ' + body.selector })); return; }
      await sendCDP('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: body.files }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000&direction=down|up|top|bottom
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const dir = q.direction || 'down';
      const jsMap = {
        top: 'window.scrollTo(0, 0); "scrolled to top"',
        bottom: 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"',
        up: `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`,
        down: `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`,
      };
      const val = await evalJS(sid, jsMap[dir] || jsMap.down);
      await new Promise(r => setTimeout(r, 800)); // 等待懒加载
      res.end(JSON.stringify({ value: val }));
    }

    // GET /wheel?target=xxx&x=400&y=300&deltaY=500 - 真实鼠标滚轮事件
    // 用于虚拟列表（如飞书文档）中 window.scrollBy 不生效的场景
    else if (pathname === '/wheel') {
      const sid = await ensureSession(q.target);
      const x = parseFloat(q.x || '400');
      const y = parseFloat(q.y || '300');
      const deltaY = parseFloat(q.deltaY || '500');
      const deltaX = parseFloat(q.deltaX || '0');
      // 先移动鼠标到目标位置
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y,
      }, sid);
      // 用 Input.emulateTouchFromMouseEvent 模拟滚动（兼容性更好）
      // 或直接用 Input.synthesizeScrollGesture
      try {
        await sendCDP('Input.synthesizeScrollGesture', {
          x, y, yDistance: -deltaY, xDistance: -deltaX,
          repeatCount: 1, speed: 800,
        }, sid);
        res.end(JSON.stringify({ wheeled: true, method: 'synthesizeScrollGesture', x, y, deltaY }));
      } catch {
        // 回退到 mouseWheel（旧版 Chrome）
        try {
          await sendCDP('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x, y, deltaX, deltaY,
          }, sid);
          res.end(JSON.stringify({ wheeled: true, method: 'mouseWheel', x, y, deltaY }));
        } catch (e) {
          res.end(JSON.stringify({ error: e.message }));
        }
      }
    }

    // POST /events/start?target=xxx - 开始收集 CDP 事件
    // body: JSON { filter: "Network", maxEvents: 200 }
    else if (pathname === '/events/start') {
      const sid = await ensureSession(q.target);
      const opts = JSON.parse(await readBody(req) || '{}');
      const id = 'col_' + Date.now();
      eventCollectors.set(id, {
        filter: opts.filter || null,
        sessionId: sid,
        events: [],
        maxEvents: opts.maxEvents || 500,
      });
      res.end(JSON.stringify({ collectorId: id }));
    }

    // GET /events/get?id=xxx&clear=true - 获取收集到的事件
    else if (pathname === '/events/get') {
      const col = eventCollectors.get(q.id);
      if (!col) { res.statusCode = 404; res.end(JSON.stringify({ error: 'collector not found' })); return; }
      const events = [...col.events];
      if (q.clear === 'true') col.events = [];
      res.end(JSON.stringify({ count: events.length, events }));
    }

    // GET /events/stop?id=xxx - 停止收集
    else if (pathname === '/events/stop') {
      eventCollectors.delete(q.id);
      res.end(JSON.stringify({ stopped: true }));
    }

    // POST /cdp?target=xxx - 发送任意 CDP 命令
    // body: JSON { method: "Network.enable", params: {} }
    // 可选 query: session=xxx 直接指定 session ID（用于 Worker 等子 target）
    else if (pathname === '/cdp') {
      // 支持不传 target 的浏览器级 CDP 命令（如 Storage.getCookies）
      const sid = q.session || (q.target ? await ensureSession(q.target) : null);
      const cmd = JSON.parse(await readBody(req));
      try {
        const result = await sendCDP(cmd.method, cmd.params || {}, sid);
        res.end(JSON.stringify(result?.result ?? result));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      }
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      const format = q.format || 'png';
      const resp = await sendCDP('Page.captureScreenshot', {
        format, quality: format === 'jpeg' ? 80 : undefined,
      }, sid);
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // ==================== 增强端点（AnyReach 新增） ====================

    // POST /setCookie?target=xxx - 注入 Cookie（支持 HttpOnly）
    // body: JSON { name, value, domain, path, httpOnly, secure, sameSite }
    else if (pathname === '/setCookie') {
      const sid = await ensureSession(q.target);
      const cookie = JSON.parse(await readBody(req));
      await sendCDP('Network.enable', {}, sid);
      const resp = await sendCDP('Network.setCookie', cookie, sid);
      res.end(JSON.stringify({ success: resp.result?.success ?? false }));
    }

    // GET /getCookies?target=xxx&domain=xxx - 获取 Cookie
    else if (pathname === '/getCookies') {
      const sid = await ensureSession(q.target);
      await sendCDP('Network.enable', {}, sid);
      const urls = q.domain ? [`https://${q.domain}`] : undefined;
      const resp = await sendCDP('Network.getCookies', urls ? { urls } : {}, sid);
      res.end(JSON.stringify(resp.result?.cookies || []));
    }

    // POST /extractText?target=xxx - 提取页面可见文本（高频操作封装）
    // 可选 body: JSON { selector, scroll } 指定容器和是否滚动加载
    else if (pathname === '/extractText') {
      const sid = await ensureSession(q.target);
      let opts = {};
      try { opts = JSON.parse(await readBody(req) || '{}'); } catch {}

      const containerSel = opts.selector || 'body';
      const shouldScroll = opts.scroll !== false;

      // 如果需要滚动，先遍历整个容器触发懒加载
      if (shouldScroll) {
        await evalJS(sid, `(async () => {
          const c = document.querySelector(${JSON.stringify(containerSel)});
          if (!c || c === document.body) {
            const h = document.body.scrollHeight;
            for (let y = 0; y < h; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); }
            window.scrollTo(0, 0);
          } else if (c.scrollHeight > c.clientHeight + 50) {
            const h = c.scrollHeight;
            for (let y = 0; y < h; y += 800) { c.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); }
            c.scrollTo(0, 0);
          }
          return 'done';
        })()`);
      }

      // 提取文本
      const text = await evalJS(sid, `(() => {
        const c = document.querySelector(${JSON.stringify(containerSel)}) || document.body;
        const skip = new Set(['SCRIPT','STYLE','SVG','NOSCRIPT']);
        function walk(node) {
          if (node.nodeType === 3) return node.textContent.trim() ? node.textContent : '';
          if (node.nodeType !== 1 || skip.has(node.tagName)) return '';
          const parts = Array.from(node.childNodes).map(walk).filter(Boolean);
          const block = ['P','DIV','H1','H2','H3','H4','H5','H6','LI','BR','TR','SECTION','ARTICLE','HEADER','FOOTER'];
          return parts.join(block.includes(node.tagName) ? '\\n' : '');
        }
        return walk(c).replace(/\\n{3,}/g, '\\n\\n').trim();
      })()`);

      res.end(JSON.stringify({ text, length: text?.length || 0 }));
    }

    // POST /fill?target=xxx - 填写表单字段
    // body: JSON { selector, value } 或 [ { selector, value }, ... ]
    else if (pathname === '/fill') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      const fields = Array.isArray(body) ? body : [body];
      const results = [];
      for (const { selector, value } of fields) {
        const val = await evalJS(sid, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { error: '未找到: ' + ${JSON.stringify(selector)} };
          el.scrollIntoView({ block: 'center' });
          el.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set;
          if (nativeSetter) nativeSetter.call(el, ${JSON.stringify(value)});
          else el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { filled: true, tag: el.tagName, selector: ${JSON.stringify(selector)} };
        })()`);
        results.push(val);
      }
      res.end(JSON.stringify(results.length === 1 ? results[0] : results));
    }

    // GET /waitFor?target=xxx&selector=xxx&timeout=5000 - 等待元素出现
    else if (pathname === '/waitFor') {
      const sid = await ensureSession(q.target);
      const selector = q.selector;
      const timeout = parseInt(q.timeout || '10000');
      if (!selector) { res.statusCode = 400; res.end(JSON.stringify({ error: '需要 selector 参数' })); return; }
      const val = await evalJS(sid, `new Promise((resolve) => {
        const sel = ${JSON.stringify(selector)};
        const timeout = ${timeout};
        const el = document.querySelector(sel);
        if (el) return resolve({ found: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) });
        const observer = new MutationObserver(() => {
          const el = document.querySelector(sel);
          if (el) { observer.disconnect(); clearTimeout(timer); resolve({ found: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) }); }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const timer = setTimeout(() => { observer.disconnect(); resolve({ found: false, timeout: true }); }, timeout);
      })`);
      if (val?.found === false) res.statusCode = 408;
      res.end(JSON.stringify(val));
    }

    // POST /preScript?target=xxx - 注入脚本，在后续每次页面导航前执行
    // 用于拦截 MediaSource、自动播放等，在页面 JS 执行前生效
    else if (pathname === '/preScript') {
      const sid = await ensureSession(q.target);
      const script = await readBody(req);
      if (!script) { res.statusCode = 400; res.end(JSON.stringify({ error: 'POST body required' })); return; }
      const resp = await sendCDP('Page.addScriptToEvaluateOnNewDocument', { source: script }, sid);
      res.end(JSON.stringify({ identifier: resp.result?.identifier }));
    }

    // POST /adapter?url=xxx - 调用站点适配器（由 adapter-runner 处理）
    else if (pathname === '/adapter') {
      const targetUrl = q.url;
      if (!targetUrl) { res.statusCode = 400; res.end(JSON.stringify({ error: '需要 url 参数' })); return; }
      // 动态加载 adapter-runner
      const runnerPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'adapter-runner.mjs');
      try {
        const { runAdapter } = await import(runnerPath);
        const result = await runAdapter(targetUrl, { proxyPort: PORT });
        res.end(JSON.stringify(result));
      } catch (e) {
        if (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'NO_ADAPTER') {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'no_adapter', url: targetUrl }));
        } else if (e.code === 'LOGIN_REQUIRED') {
          res.statusCode = 401;
          res.end(JSON.stringify({
            error: 'login_required',
            loginType: e.loginInfo?.type || null,
            screenshotPath: e.loginInfo?.screenshotPath || null,
            message: e.loginInfo?.message || '需要登录',
          }));
        } else {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      }
    }

    // --- 404 ---
    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出页面 tab',
          '/new?url=': 'GET - 创建后台 tab',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=&url=': 'GET - 导航',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面信息',
          '/eval?target=': 'POST body=JS - 执行 JS',
          '/click?target=': 'POST body=选择器 - JS 点击',
          '/clickAt?target=': 'POST body=选择器 - 真实鼠标点击',
          '/setFiles?target=': 'POST JSON - 文件上传',
          '/fill?target=': 'POST JSON - 填写表单',
          '/scroll?target=&direction=': 'GET - 滚动',
          '/screenshot?target=&file=': 'GET - 截图',
          '/extractText?target=': 'POST JSON - 提取文本',
          '/setCookie?target=': 'POST JSON - 注入 Cookie',
          '/getCookies?target=': 'GET - 获取 Cookie',
          '/waitFor?target=&selector=': 'GET - 等待元素',
          '/preScript?target=': 'POST body=JS - 注入页面前置脚本',
          '/adapter?url=': 'POST - 调用站点适配器',
        },
      }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// --- 启动 ---
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  const available = await checkPortAvailable(PORT);
  if (!available) {
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok"')));
        }).on('error', () => resolve(false));
      });
      if (ok) { console.log(`[AnyReach] 已有实例在端口 ${PORT}，退出`); process.exit(0); }
    } catch {}
    console.error(`[AnyReach] 端口 ${PORT} 被占用`);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[AnyReach] 运行在 http://localhost:${PORT}`);
    connect().catch(e => console.error('[AnyReach] 初始连接失败:', e.message));
  });
}

process.on('uncaughtException', (e) => console.error('[AnyReach] 异常:', e.message));
process.on('unhandledRejection', (e) => console.error('[AnyReach] 拒绝:', e?.message || e));

main();
