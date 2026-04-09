// login-detector.mjs — 通用登录墙检测与捕获
//
// 三个对外方法：
//   detect(proxy, targetId)      → null | { type: 'qr' | 'form' | 'unknown' }
//   capture(proxy, targetId)     → { type, screenshotPath?, fields?, message }
//   waitForLogin(proxy, targetId, opts) → { success, elapsed }

import os from 'node:os';
import path from 'node:path';

// 常见二维码选择器（微信/支付宝/企业微信等）
const QR_SELECTORS = [
  'canvas',
  'img[src*=qrcode]', 'img[src*=qr_code]', 'img[src*=qr-code]',
  '.qrcode', '.qr-code', '.qr_code', '#qrcode', '#qr-code',
  '[class*=qrcode]', '[class*=qr-code]',
  'img[alt*=二维码]', 'img[alt*=QR]',
];

// 登录页文字特征（多语言）
const LOGIN_TEXT_PATTERNS = [
  '微信快捷登录', '使用微信登录', '微信扫码', '扫码登录',
  '请登录', '登录后', '立即登录',
  'Sign in', 'Log in', 'Login to',
];

// 账号密码表单选择器
const PASSWORD_SELECTORS = [
  'input[type=password]',
  'input[name*=password]', 'input[name*=passwd]', 'input[name*=pwd]',
  'input[placeholder*=密码]', 'input[placeholder*=password]',
];

// 已登录的内容特征（命中任一则认为已登录，防止误判）
const CONTENT_SELECTORS = [
  '.post-item', '.compact-card', '.content-mt',   // scys
  '.feed-item', '.article', '.post-list',          // 通用内容
  'nav[class*=user]', '[class*=avatar][src*=http]', // 已登录用户信息
];

/**
 * 检测页面是否有登录墙。
 * 返回 null 表示无需登录，否则返回 { type }。
 */
export async function detect(proxy, targetId) {
  return proxy.eval(targetId, `(() => {
    const text = document.body?.innerText || '';

    // 命中已登录内容特征 → 直接认为已登录
    const contentSelectors = ${JSON.stringify(CONTENT_SELECTORS)};
    if (contentSelectors.some(s => { try { return !!document.querySelector(s); } catch { return false; }})) {
      return null;
    }

    // 检测登录文字特征
    const textPatterns = ${JSON.stringify(LOGIN_TEXT_PATTERNS)};
    const hasLoginText = textPatterns.some(p => text.includes(p));
    if (!hasLoginText) return null;

    // 区分二维码 vs 账密
    const qrSelectors = ${JSON.stringify(QR_SELECTORS)};
    const hasQR = qrSelectors.some(s => { try { return !!document.querySelector(s); } catch { return false; }});
    if (hasQR) return { type: 'qr' };

    const pwdSelectors = ${JSON.stringify(PASSWORD_SELECTORS)};
    const hasPassword = pwdSelectors.some(s => { try { return !!document.querySelector(s); } catch { return false; }});
    if (hasPassword) return { type: 'form' };

    return { type: 'unknown' };
  })()`).catch(() => null);
}

/**
 * 截图登录页（二维码全页截图）或返回表单字段信息。
 * 返回 { type, screenshotPath?, fields?, message }。
 */
export async function capture(proxy, targetId) {
  const detected = await detect(proxy, targetId);
  if (!detected) return null;

  if (detected.type === 'qr' || detected.type === 'unknown') {
    const screenshotPath = path.join(os.tmpdir(), `anyreach-login-${Date.now()}.png`);
    await proxy.screenshot(targetId, screenshotPath);
    return {
      type: detected.type === 'qr' ? 'qr' : 'unknown',
      screenshotPath,
      message: detected.type === 'qr'
        ? `检测到二维码登录，已截图至 ${screenshotPath}`
        : `检测到登录墙（类型未知），已截图至 ${screenshotPath}`,
    };
  }

  if (detected.type === 'form') {
    const fields = await proxy.eval(targetId, `(() => {
      return Array.from(document.querySelectorAll('input:not([type=hidden])'))
        .map(i => ({
          type: i.type || 'text',
          name: i.name || i.id || '',
          placeholder: i.placeholder || '',
          selector: i.id ? '#' + i.id : (i.name ? '[name="' + i.name + '"]' : null),
        }))
        .filter(f => f.selector);
    })()`).catch(() => []);
    return {
      type: 'form',
      fields,
      message: `检测到账号密码登录，共 ${fields.length} 个输入字段`,
    };
  }

  return { type: detected.type, message: '检测到登录墙' };
}

/**
 * 轮询等待登录完成（登录墙消失视为成功）。
 * timeout: 最长等待 ms（默认 3 分钟）
 * pollInterval: 每次检查间隔 ms（默认 3 秒）
 */
export async function waitForLogin(proxy, targetId, { timeout = 180000, pollInterval = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, pollInterval));
    const still = await detect(proxy, targetId);
    if (!still) return { success: true, elapsed: Date.now() - start };
  }
  return { success: false, elapsed: timeout };
}
