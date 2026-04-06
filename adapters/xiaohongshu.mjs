// AnyReach 小红书适配器
// 支持三种页面类型：
//   - note: 单篇笔记（图文 or 视频）
//   - profile: 博主主页（笔记列表）
//   - feed: 首页/搜索结果（笔记列表）

import { sleep, downloadMedia, scrollToLoad } from './_utils.mjs';

// --- JS extraction snippets ---

const EXTRACT_NOTE_JS = `(() => {
  const title = document.querySelector('.title')?.innerText?.trim() || '';
  const desc = document.querySelector('#detail-desc, .desc')?.innerText?.trim() || '';
  const author = document.querySelector('.author-wrapper .username, .user-name')?.innerText?.trim() || '';
  const date = document.querySelector('.date, [class*=date]')?.innerText?.trim() || '';

  const imgEls = document.querySelectorAll('.swiper-slide img, .note-slider img');
  const images = [...new Set(Array.from(imgEls).map(i => i.src || i.dataset?.src).filter(Boolean))];

  const videoEl = document.querySelector('video');
  let video = null;
  if (videoEl) {
    const src = videoEl.src || videoEl.currentSrc || '';
    const sourceSrc = videoEl.querySelector('source')?.src || '';
    if (src && !src.startsWith('blob:')) video = src;
    else if (sourceSrc && !sourceSrc.startsWith('blob:')) video = sourceSrc;
    else video = src || null;
  }

  const tags = Array.from(document.querySelectorAll('#detail-desc a, .desc a'))
    .map(a => a.innerText?.trim()).filter(t => t.startsWith('#'));

  const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || '0';

  return {
    title, desc, author, date,
    type: video ? 'video' : 'image',
    images, video, tags,
    interaction: {
      likes: getText('.like-wrapper .count, [class*=like-wrapper] .count'),
      collects: getText('.collect-wrapper .count, [class*=collect-wrapper] .count'),
      comments: getText('.chat-wrapper .count, [class*=chat-wrapper] .count'),
    },
  };
})()`;

const EXTRACT_CARDS_JS = `(() => {
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

    if (pageType === 'note') return this._extractNote(proxy, targetId);
    if (pageType === 'profile') return this._extractList(proxy, targetId, limit, 'profile');
    if (pageType === 'feed') return this._extractList(proxy, targetId, limit, 'feed');
    return { error: `unknown page type for URL: ${url}` };
  },

  async _extractNote(proxy, targetId) {
    await proxy.waitFor(targetId, '.note-container, #noteContainer', 10000).catch(() => {});
    await sleep(1000);

    const note = await proxy.eval(targetId, EXTRACT_NOTE_JS);
    if (!note) return { error: 'failed to extract note content' };

    // attempt CDN URL recovery for blob: video
    if (note.type === 'video' && note.video?.startsWith('blob:')) {
      const cdnUrl = await proxy.eval(targetId, `(() => {
        const v = document.querySelector('video');
        if (!v) return null;
        const src = v.getAttribute('src') || '';
        const sources = Array.from(v.querySelectorAll('source')).map(s => s.src);
        return [src, v.currentSrc, ...sources].find(u => u && !u.startsWith('blob:')) || null;
      })()`);
      if (cdnUrl) note.video = cdnUrl;
    }

    return { ...note, content: [note.title, note.desc].filter(Boolean).join('\n\n'), format: 'json' };
  },

  async _extractList(proxy, targetId, limit, listType) {
    await proxy.waitFor(targetId, 'section.note-item, .feeds-container .note-item', 10000).catch(() => {});
    await sleep(1000);

    let userInfo = null;
    if (listType === 'profile') {
      userInfo = await proxy.eval(targetId, EXTRACT_USER_JS);
    }

    const cards = await scrollToLoad(proxy, targetId, { extractJS: EXTRACT_CARDS_JS, limit });

    return { listType, user: userInfo, cards, cardCount: cards.length, format: 'json' };
  },

  // batch extract note details from card URLs
  async extractNotes(proxy, cards, opts = {}) {
    const concurrency = opts.concurrency || 3;
    const results = [];

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
      if (i + concurrency < cards.length) await sleep(2000);
    }

    return { notes: results, count: results.length };
  },

  // download note media to local directory
  async downloadNoteMedia(note, destDir) {
    return downloadMedia(note, destDir);
  },
};
