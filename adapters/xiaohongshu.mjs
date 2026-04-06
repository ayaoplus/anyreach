// AnyReach 小红书适配器
// 支持三种页面类型：
//   - note: 单篇笔记（图文 or 视频）
//   - profile: 博主主页（笔记列表）
//   - feed: 首页/搜索结果（笔记列表）
//
// 小红书特征：
//   - 反爬严格，URL 需要 xsec_token，不可手动构造
//   - 图片在 .swiper-slide img，轮播可能产生重复
//   - 视频 <video> 标签，播放前 src 为 CDN 直链，播放后变为 blob:
//   - 列表页需滚动加载更多笔记

import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- 笔记详情提取 ---

const EXTRACT_NOTE_JS = `(() => {
  const title = document.querySelector('.title')?.innerText?.trim() || '';
  const desc = document.querySelector('#detail-desc, .desc')?.innerText?.trim() || '';
  const author = document.querySelector('.author-wrapper .username, .user-name')?.innerText?.trim() || '';
  const date = document.querySelector('.date, [class*=date]')?.innerText?.trim() || '';

  // 图片（去重，轮播会产生重复 DOM）
  const imgEls = document.querySelectorAll('.swiper-slide img, .note-slider img');
  const imgUrls = [...new Set(Array.from(imgEls).map(i => i.src || i.dataset?.src).filter(Boolean))];

  // 视频（优先取非 blob URL；播放后 src 会被 MediaSource 替换为 blob:）
  const videoEl = document.querySelector('video');
  let videoSrc = null;
  if (videoEl) {
    const src = videoEl.src || videoEl.currentSrc || '';
    const sourceSrc = videoEl.querySelector('source')?.src || '';
    // 优先用非 blob 的直链
    if (src && !src.startsWith('blob:')) videoSrc = src;
    else if (sourceSrc && !sourceSrc.startsWith('blob:')) videoSrc = sourceSrc;
    else videoSrc = src || null; // fallback to blob if nothing else
  }

  // 标签
  const tags = Array.from(document.querySelectorAll('#detail-desc a, .desc a'))
    .map(a => a.innerText?.trim())
    .filter(t => t.startsWith('#'));

  // 互动数据
  const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || '0';

  return {
    title,
    desc,
    author,
    date,
    type: videoSrc ? 'video' : 'image',
    images: imgUrls,
    video: videoSrc,
    tags,
    interaction: {
      likes: getText('.like-wrapper .count, [class*=like-wrapper] .count'),
      collects: getText('.collect-wrapper .count, [class*=collect-wrapper] .count'),
      comments: getText('.chat-wrapper .count, [class*=chat-wrapper] .count'),
    },
  };
})()`;

// --- 列表页笔记卡片提取 ---

const EXTRACT_CARDS_JS = `(() => {
  // profile 页用 .feeds-container .note-item，首页用 .feeds-page .note-item 或 section.note-item
  const items = document.querySelectorAll('.feeds-container .note-item, section.note-item');
  return Array.from(items).map(item => {
    const link = item.querySelector('a[href*="/explore/"]');
    const cover = item.querySelector('img');
    const titleEl = item.querySelector('[class*=title]');
    const likeEl = item.querySelector('[class*=count]');
    return {
      url: link?.href || null,
      cover: cover?.src || null,
      title: titleEl?.innerText?.trim() || '',
      likes: likeEl?.innerText?.trim() || '',
    };
  }).filter(c => c.url);
})()`;

// --- 用户信息提取 ---

const EXTRACT_USER_JS = `(() => {
  const name = document.querySelector('.user-name')?.innerText?.trim() || '';
  const desc = document.querySelector('.user-desc')?.innerText?.trim() || '';
  const info = {};
  document.querySelectorAll('.data-info .data-item, [class*=data-info] [class*=data-item]').forEach(el => {
    const count = el.querySelector('.count')?.innerText?.trim();
    const label = el.querySelector('.label, span:last-child')?.innerText?.trim();
    if (count && label) info[label] = count;
  });
  return { name, desc, stats: info };
})()`;

// --- 下载媒体文件到本地 ---

async function downloadFile(url, destPath) {
  if (!url || url.startsWith('blob:')) return { error: 'blob URL cannot be downloaded directly' };
  const res = await fetch(url);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return { saved: destPath, size: buffer.length };
}

export default {
  name: 'xiaohongshu',
  domains: ['xiaohongshu.com', 'xhslink.com'],
  description: 'Xiaohongshu note extraction (image+text, video+text, profile listing)',

  detect(url) {
    if (url.includes('/explore/') && /\/explore\/[a-f0-9]{24}/.test(url)) return 'note';
    if (url.includes('/user/profile/')) return 'profile';
    if (url.includes('/explore') && !url.includes('/explore/')) return 'feed';
    if (url.includes('/search_result')) return 'feed';
    return 'unknown';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType, url } = ctx;
    const limit = ctx.limit || 10;

    if (pageType === 'note') {
      return this._extractNote(proxy, targetId, url);
    }
    if (pageType === 'profile') {
      return this._extractList(proxy, targetId, limit, 'profile');
    }
    if (pageType === 'feed') {
      return this._extractList(proxy, targetId, limit, 'feed');
    }

    return { error: `unknown page type for URL: ${url}` };
  },

  // --- 单篇笔记提取 ---
  async _extractNote(proxy, targetId, /* url */) {
    // wait for note content to render
    await proxy.waitFor(targetId, '.note-container, #noteContainer', 10000).catch(() => {});
    await sleep(1000);

    const note = await proxy.eval(targetId, EXTRACT_NOTE_JS);
    if (!note) return { error: 'failed to extract note content' };

    // For video notes: blob: URLs can't be downloaded directly.
    // Attempt to get the CDN URL from video element attributes.
    // If still blob:, the video can be captured via /screenshot frame-by-frame,
    // or the caller can use the blob URL for in-browser playback.
    if (note.type === 'video' && note.video?.startsWith('blob:')) {
      const cdnUrl = await proxy.eval(targetId, `(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        // check data attributes and source children
        const src = v.getAttribute('src') || '';
        const sources = Array.from(v.querySelectorAll('source')).map(s => s.src);
        const all = [src, v.currentSrc, ...sources];
        return all.find(u => u && !u.startsWith('blob:')) || null;
      })()`);
      if (cdnUrl) note.video = cdnUrl;
    }

    return {
      ...note,
      content: [note.title, note.desc].filter(Boolean).join('\n\n'),
      format: 'json',
    };
  },

  // --- 列表页提取（profile / feed） ---
  async _extractList(proxy, targetId, limit, listType) {
    // wait for initial cards to render
    await proxy.waitFor(targetId, 'section.note-item, .feeds-container .note-item', 10000);
    await sleep(1000);

    // extract user info if profile page
    let userInfo = null;
    if (listType === 'profile') {
      userInfo = await proxy.eval(targetId, EXTRACT_USER_JS);
    }

    // scroll to load enough cards
    let cards = [];
    let scrollAttempts = 0;
    const maxScrollAttempts = 20;

    while (cards.length < limit && scrollAttempts < maxScrollAttempts) {
      const current = await proxy.eval(targetId, EXTRACT_CARDS_JS);
      if (current && current.length > cards.length) {
        cards = current;
      }
      if (cards.length >= limit) break;
      // scroll down to trigger lazy loading
      await proxy.scroll(targetId, { direction: 'bottom' });
      await sleep(1500);
      scrollAttempts++;

      // check if new cards appeared
      const after = await proxy.eval(targetId, EXTRACT_CARDS_JS);
      if (after && after.length <= cards.length) {
        // no new cards after scroll, reached the end
        break;
      }
      cards = after;
    }

    // trim to limit
    cards = cards.slice(0, limit);

    return {
      listType,
      user: userInfo,
      cards,
      cardCount: cards.length,
      format: 'json',
    };
  },

  // --- 批量提取笔记详情（从列表页的卡片 URL 逐个打开） ---
  // 调用方式：先 extract 拿到 cards，再用此方法逐个提取
  async extractNotes(proxy, cards, opts = {}) {
    const concurrency = opts.concurrency || 3;
    const results = [];

    // 分批并行
    for (let i = 0; i < cards.length; i += concurrency) {
      const batch = cards.slice(i, i + concurrency);
      const promises = batch.map(async (card) => {
        if (!card.url) return { error: 'no url', card };
        const tid = await proxy.newTab(card.url);
        try {
          await proxy.waitFor(tid, '.note-container, #noteContainer', 10000).catch(() => {});
          await sleep(1000);
          const note = await proxy.eval(tid, EXTRACT_NOTE_JS);
          return { ...note, sourceUrl: card.url };
        } catch (e) {
          return { error: e.message, sourceUrl: card.url };
        } finally {
          await proxy.close(tid).catch(() => {});
        }
      });
      results.push(...await Promise.all(promises));
      // rate limit between batches
      if (i + concurrency < cards.length) await sleep(2000);
    }

    return { notes: results, count: results.length };
  },

  // --- 下载笔记中的媒体文件 ---
  async downloadMedia(note, destDir) {
    fs.mkdirSync(destDir, { recursive: true });

    const results = [];
    if (note.type === 'video' && note.video) {
      const ext = note.video.includes('.mp4') ? 'mp4' : 'mp4';
      const dest = path.join(destDir, `video.${ext}`);
      results.push(await downloadFile(note.video, dest));
    }
    if (note.images?.length > 0) {
      for (let i = 0; i < note.images.length; i++) {
        const ext = note.images[i].includes('.png') ? 'png' : 'jpg';
        const dest = path.join(destDir, `image_${i + 1}.${ext}`);
        results.push(await downloadFile(note.images[i], dest));
      }
    }
    return results;
  },
};
