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
    // 安全选择器匹配：忽略无效选择器
    function has(list) {
      return list.some(s => { try { return !!document.querySelector(s); } catch { return false; }});
    }

    // 命中已登录内容特征 → 直接认为已登录
    const contentSelectors = ${JSON.stringify(CONTENT_SELECTORS)};
    if (has(contentSelectors)) return null;

    // 缩小登录文字检测范围，避免正文内容误判
    const textPatterns = ${JSON.stringify(LOGIN_TEXT_PATTERNS)};
    const modalSelectors = '.modal, [class*=login], [class*=dialog], [role=dialog], [class*=overlay], [class*=signin]';
    const modalEls = document.querySelectorAll(modalSelectors);
    let hasLoginText = false;

    // 优先在 modal/dialog/overlay 容器中检测登录文字
    for (const el of modalEls) {
      const elText = el.innerText || '';
      if (textPatterns.some(p => elText.includes(p))) {
        hasLoginText = true;
        break;
      }
    }

    // 如果没有 modal 命中，仅在页面主体内容极短时才信任全页文字检测
    if (!hasLoginText) {
      const bodyText = document.body?.innerText || '';
      if (bodyText.length < 200 && textPatterns.some(p => bodyText.includes(p))) {
        hasLoginText = true;
      }
    }

    if (!hasLoginText) return null;

    // 区分二维码 vs 账密
    const qrSelectors = ${JSON.stringify(QR_SELECTORS)};
    if (has(qrSelectors)) return { type: 'qr' };

    const pwdSelectors = ${JSON.stringify(PASSWORD_SELECTORS)};
    if (has(pwdSelectors)) return { type: 'form' };

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
