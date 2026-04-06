// AnyReach 生财有术适配器
// 支持页面类型：
//   - article:   帖子详情（完整内容 or 外部链接摘要）
//   - opportunity: 风向标列表（支持 filter=bid 中标筛选）
//   - activity:  航海项目列表
//   - course:    航海手册详情（多章节，逐章提取）
//
// DOM 关键选择器：
//   帖子内容:  .content-mt
//   风向标卡片: .post-item
//   航海卡片:   .vc-navigation-card
//   手册侧边栏: .vc-course-sidebar → .catalogue-section → .vc-chapter-item
//   手册内容:   .content-mt

import { sleep, downloadMedia, scrollToLoad } from './_utils.mjs';

// =========================================================
// JS extraction snippets (run inside browser via proxy.eval)
// =========================================================

// --- 帖子详情 ---
const EXTRACT_ARTICLE_JS = `(() => {
  const content = document.querySelector('.content-mt');
  if (!content) return null;

  // author + date in the top area
  const topInfo = content.querySelector('.post-item-top, [class*=author]');
  const author = topInfo?.querySelector('.name-identity, .nickname, [class*=name]')?.innerText?.trim() || '';
  const date = topInfo?.querySelector('[class*=time], [class*=date]')?.innerText?.trim() || '';

  // title: first major heading or bold text
  const titleEl = content.querySelector('h1, h2, .title, [class*=title]');
  const title = titleEl?.innerText?.trim() || '';

  // full text
  const text = content.innerText?.trim() || '';

  // images
  const imgs = Array.from(content.querySelectorAll('img'))
    .map(i => i.src)
    .filter(s => s && !s.includes('avatar') && !s.includes('emoji'));

  // external links (feishu etc)
  const links = Array.from(content.querySelectorAll('a'))
    .map(a => ({ text: a.innerText?.trim()?.slice(0,60), href: a.href }))
    .filter(l => l.href && !l.href.includes('scys.com'));

  // tags
  const tags = Array.from(content.querySelectorAll('[class*=tag], .tag'))
    .map(t => t.innerText?.trim()).filter(Boolean);

  // interaction (likes, collects, comments)
  const counts = Array.from(content.querySelectorAll('[class*=action] [class*=count], .vc-post-action-bar span'))
    .map(el => el.innerText?.trim()).filter(Boolean);

  return { title, author, date, text, imgs, externalLinks: links, tags, interactionCounts: counts };
})()`;

// --- 风向标列表卡片 ---
const EXTRACT_OPP_CARDS_JS = `(() => {
  const cards = document.querySelectorAll('.post-item');
  return Array.from(cards).map(c => {
    const nameEl = c.querySelector('.name-identity');
    const author = nameEl?.innerText?.trim() || '';
    const dateEl = c.querySelector('[class*=time]');
    const date = dateEl?.innerText?.trim() || '';
    const isBid = c.innerText?.includes('中标') || !!c.querySelector('[class*=bid]');
    const text = c.innerText?.trim() || '';
    // extract first line as title (skip author/date lines)
    const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
    const titleIdx = lines.findIndex(l => l.length > 10 && l !== author && !l.match(/^\\d/));
    const title = titleIdx >= 0 ? lines[titleIdx]?.slice(0,80) : '';
    const tags = Array.from(c.querySelectorAll('[class*=tag]')).map(t => t.innerText?.trim()).filter(Boolean);
    return { author, date, title, isBid, tags, preview: text.slice(0,200) };
  });
})()`;

// --- 航海项目列表卡片 ---
const EXTRACT_ACTIVITY_CARDS_JS = `(() => {
  const cards = document.querySelectorAll('.vc-navigation-card');
  return Array.from(cards).map(c => {
    const title = c.querySelector('[class*=title], h3, h4')?.innerText?.trim() || '';
    const desc = c.querySelector('[class*=desc], p')?.innerText?.trim() || '';
    const state = c.querySelector('.state')?.innerText?.trim() || '';
    const dateRange = c.innerText?.match(/(\\d{2}\\.\\d{2}\\s*-\\s*\\d{2}\\.\\d{2})/)?.[1] || '';
    // "查看手册" button opens a new tab via Vue event (no href in DOM)
    // we detect its presence; the caller can use clickCourseButton() to open it
    const hasManual = !!Array.from(c.querySelectorAll('span, div')).find(el => el.innerText?.trim() === '查看手册');
    return { title, desc, state, dateRange, hasManual };
  });
})()`;

// --- 航海手册目录（异步：展开后等待渲染） ---
const EXPAND_ALL_SECTIONS_JS = `(async () => {
  const collapsed = document.querySelectorAll('.vc-section-header:not(.expanded)');
  for (const h of collapsed) {
    h.click();
    await new Promise(r => setTimeout(r, 800));
  }
  return collapsed.length;
})()`;

const EXTRACT_COURSE_TOC_JS = `(() => {
  const sections = document.querySelectorAll('.catalogue-section');
  return Array.from(sections).map(s => {
    const header = s.querySelector('.vc-section-header')?.innerText?.trim() || '';
    const chapters = Array.from(s.querySelectorAll('.vc-chapter-item')).map((c, idx) => ({
      name: c.querySelector('.name')?.innerText?.trim() || c.innerText?.trim()?.split('\\n')[0],
      index: idx,
      active: c.classList.contains('is-active'),
    }));
    return { header, chapters };
  });
})()`;

// --- 航海手册当前章节内容 ---
const EXTRACT_COURSE_CONTENT_JS = `(() => {
  const content = document.querySelector('.content-mt');
  if (!content) return null;
  const text = content.innerText?.trim() || '';
  const imgs = Array.from(content.querySelectorAll('img'))
    .map(i => i.src).filter(s => s && s.startsWith('http'));
  const videos = Array.from(content.querySelectorAll('video'))
    .map(v => v.src || v.querySelector('source')?.src).filter(Boolean);
  return { text, imgs, videos, textLength: text.length };
})()`;

// (downloadFile and downloadMedia imported from _utils.mjs)

// =========================================================
// Adapter export
// =========================================================
export default {
  name: 'scys',
  domains: ['scys.com'],
  description: '生财有术：帖子、风向标、航海项目、航海手册',

  detect(url) {
    if (url.includes('/articleDetail/')) return 'article';
    if (url.includes('/opportunity')) return 'opportunity';
    if (url.includes('/course/detail/')) return 'course';
    if (url.includes('/activity')) return 'activity';
    return 'unknown';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType } = ctx;
    const limit = ctx.limit || 20;

    switch (pageType) {
      case 'article':
        return this._extractArticle(proxy, targetId);
      case 'opportunity':
        return this._extractOpportunityList(proxy, targetId, limit, ctx);
      case 'activity':
        return this._extractActivityList(proxy, targetId, limit);
      case 'course':
        return this._extractCourse(proxy, targetId);
      default:
        return { error: `unsupported page type: ${pageType}` };
    }
  },

  // --- 帖子详情 ---
  async _extractArticle(proxy, targetId) {
    await proxy.waitFor(targetId, '.content-mt', 10000).catch(() => {});
    await sleep(1000);
    const article = await proxy.eval(targetId, EXTRACT_ARTICLE_JS);
    if (!article) return { error: 'failed to extract article' };
    return { ...article, format: 'json' };
  },

  // --- 风向标列表 ---
  async _extractOpportunityList(proxy, targetId, limit, ctx) {
    await proxy.waitFor(targetId, '.post-item', 10000).catch(() => {});
    await sleep(1000);

    // if bid-only filter requested, click the "中标" tab
    const bidOnly = ctx.url?.includes('filter=bid') || ctx.bidOnly;
    if (bidOnly) {
      await proxy.eval(targetId, `(() => {
        const tabs = document.querySelectorAll('[class*=tab], [class*=filter]');
        const bidTab = Array.from(tabs).find(t => t.innerText?.trim() === '中标');
        if (bidTab) bidTab.click();
        return !!bidTab;
      })()`);
      await sleep(1500);
    }

    let cards = await scrollToLoad(proxy, targetId, { extractJS: EXTRACT_OPP_CARDS_JS, limit });
    if (bidOnly) cards = cards.filter(c => c.isBid);

    return { listType: 'opportunity', bidOnly: !!bidOnly, cards, cardCount: cards.length, format: 'json' };
  },

  // --- 航海项目列表 ---
  async _extractActivityList(proxy, targetId, limit) {
    await proxy.waitFor(targetId, '.vc-navigation-card', 10000).catch(() => {});
    await sleep(1000);

    const cards = await scrollToLoad(proxy, targetId, { extractJS: EXTRACT_ACTIVITY_CARDS_JS, limit, maxScrollAttempts: 10 });

    return { listType: 'activity', cards, cardCount: cards.length, format: 'json' };
  },

  // --- 航海手册（逐章提取） ---
  async _extractCourse(proxy, targetId) {
    await proxy.waitFor(targetId, '.vc-course-sidebar', 10000).catch(() => {});
    await sleep(1000);

    // get course title
    const courseTitle = await proxy.eval(targetId,
      `document.querySelector('.vc-course-info [class*=title], .vc-course-info h2')?.innerText?.trim() || document.title`
    );

    // expand all collapsed sections, then get TOC
    await proxy.eval(targetId, EXPAND_ALL_SECTIONS_JS);
    await sleep(1000);
    const toc = await proxy.eval(targetId, EXTRACT_COURSE_TOC_JS);

    // extract each chapter by clicking through sidebar
    const chapters = [];
    if (!toc) return { title: courseTitle, chapters: [], error: 'failed to get TOC' };

    for (const section of toc) {
      for (const ch of section.chapters) {
        // click this chapter in sidebar
        const clicked = await proxy.eval(targetId, `(() => {
          const items = document.querySelectorAll('.vc-chapter-item');
          for (const item of items) {
            const name = item.querySelector('.name')?.innerText?.trim() || item.innerText?.trim()?.split('\\n')[0];
            if (name === ${JSON.stringify(ch.name)}) {
              item.click();
              return true;
            }
          }
          return false;
        })()`);

        if (!clicked) {
          chapters.push({ section: section.header, name: ch.name, error: 'chapter not found in sidebar' });
          continue;
        }

        // wait for content to update
        await sleep(1500);

        // extract content
        const content = await proxy.eval(targetId, EXTRACT_COURSE_CONTENT_JS);
        chapters.push({
          section: section.header,
          name: ch.name,
          text: content?.text || '',
          images: content?.imgs || [],
          videos: content?.videos || [],
          textLength: content?.textLength || 0,
        });
      }
    }

    return {
      title: courseTitle,
      toc,
      chapters,
      totalChapters: chapters.length,
      format: 'json',
    };
  },

  // --- 通过点击"查看手册"获取课程 URL ---
  // cardIndex: 活动列表中卡片的索引（0-based）
  async openCourseFromActivity(proxy, activityTargetId, cardIndex) {
    // record existing tabs
    const beforeTabs = await proxy._fetch('/targets');
    const beforeIds = new Set(beforeTabs.map(t => t.targetId));

    // click the nth card's "查看手册" button
    await proxy.eval(activityTargetId, `(() => {
      const cards = document.querySelectorAll('.vc-navigation-card');
      const card = cards[${cardIndex}];
      if (!card) return false;
      const btn = Array.from(card.querySelectorAll('.button')).find(b => b.innerText?.includes('查看手册'));
      if (btn) { btn.click(); return true; }
      return false;
    })()`);

    await sleep(3000);

    // find the new tab (course URL)
    const afterTabs = await proxy._fetch('/targets');
    const newTab = afterTabs.find(t => !beforeIds.has(t.targetId) && t.url?.includes('/course/'));
    if (!newTab) return { error: 'no course tab opened' };

    return { courseUrl: newTab.url, targetId: newTab.targetId };
  },

  // --- 下载手册中所有媒体 ---
  async downloadCourseMedia(courseResult, destDir) {
    const results = [];
    for (const ch of (courseResult.chapters || [])) {
      const chName = ch.name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 50);
      const chDir = `${destDir}/${chName}`;
      if (ch.images?.length > 0 || ch.videos?.length > 0) {
        results.push(...await downloadMedia({ images: ch.images, videos: ch.videos }, chDir));
      }
    }
    return results;
  },
};
