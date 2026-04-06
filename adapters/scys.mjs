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

// --- 风向标列表卡片（预览模式） ---
const EXTRACT_OPP_CARDS_JS = `(() => {
  const cards = document.querySelectorAll('.post-item');
  return Array.from(cards).map(c => {
    const author = c.querySelector('.name-identity .name')?.innerText?.trim() || '';
    const date = c.querySelector('.date')?.innerText?.trim() || '';
    const isBid = !!c.querySelector('.hit-icon');
    const title = c.querySelector('.post-title')?.innerText?.trim() || '';
    const category = c.querySelector('.title-line .icon')?.innerText?.trim() || '';
    const tags = Array.from(c.querySelectorAll('.label-box [class*=tag], .label-box span')).map(t => t.innerText?.trim()).filter(Boolean);
    const preview = c.querySelector('.content-container')?.innerText?.trim()?.slice(0, 200) || '';
    return { author, date, title, category, isBid, tags, preview };
  });
})()`;

// --- 风向标卡片（归档模式：展开后的完整数据） ---
const EXTRACT_OPP_CARDS_ARCHIVE_JS = `(() => {
  const cards = document.querySelectorAll('.post-item');
  return Array.from(cards).map(c => {
    const author = c.querySelector('.name-identity .name')?.innerText?.trim() || '';
    const date = c.querySelector('.date')?.innerText?.trim() || '';
    const isBid = !!c.querySelector('.hit-icon');
    const title = c.querySelector('.post-title')?.innerText?.trim() || '';
    const category = c.querySelector('.title-line .icon')?.innerText?.trim() || '';
    const tags = Array.from(c.querySelectorAll('.label-box [class*=tag], .label-box span')).map(t => t.innerText?.trim()).filter(Boolean);

    // 完整正文（展开后 .content-container 包含全部内容）
    const text = c.querySelector('.content-container')?.innerText?.trim() || '';

    // 图片：.image-list 中的 img，取实际 src
    const images = Array.from(c.querySelectorAll('.image-list img'))
      .map(i => i.src)
      .filter(s => s && s.startsWith('http'));

    // AI 提炼
    const aiSummary = c.querySelector('.ai-summary-container')?.innerText?.replace('智能提炼', '')?.trim() || '';

    // 互动数据
    const interactionEls = c.querySelectorAll('.interactions .item');
    const interactions = Array.from(interactionEls).map(el => el.innerText?.trim()).filter(Boolean);

    // 是否还有"展开全文"按钮（未展开标记）
    const hasExpand = !!c.querySelector('.flex-btn');

    return { author, date, title, category, isBid, tags, text, images, aiSummary, interactions, hasExpand };
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

// --- 航海手册目录（异步：展开所有折叠的 section） ---
const EXPAND_ALL_SECTIONS_JS = `(async () => {
  const collapsed = document.querySelectorAll('.vc-section-header:not(.expanded)');
  for (const h of collapsed) {
    h.click();
    await new Promise(r => setTimeout(r, 800));
  }
  return collapsed.length;
})()`;

// 提取课程目录结构
const EXTRACT_COURSE_TOC_JS = `(() => {
  const sections = document.querySelectorAll('.vc-course-catalogue .catalogue-section');
  return Array.from(sections).map(s => {
    const header = s.querySelector('.section-title')?.innerText?.trim()
      || s.querySelector('.vc-section-header')?.innerText?.trim() || '';
    const items = s.querySelectorAll('.vc-chapter-item');
    const chapters = Array.from(items).map((c, idx) => ({
      name: c.querySelector('.chapter-title')?.innerText?.trim()
        || c.querySelector('.chapter-content')?.innerText?.trim()?.split('\\n')[0]
        || c.innerText?.trim()?.split('\\n')[0],
      index: idx,
      active: c.classList.contains('is-active'),
      meta: c.querySelector('.chapter-meta')?.innerText?.trim() || '',
    }));
    return { header, chapters };
  }).filter(s => s.chapters.length > 0);
})()`;

// --- 航海手册当前章节内容 ---
// 精确提取 .vc-course-content 下的标题和正文，避免混入侧边栏
const EXTRACT_COURSE_CONTENT_JS = `(() => {
  const courseContent = document.querySelector('.vc-course-content');
  if (!courseContent) {
    // 回退到 .content-mt
    const mt = document.querySelector('.content-mt');
    if (!mt) return null;
    const text = mt.innerText?.trim() || '';
    return { text, imgs: [], videos: [], textLength: text.length };
  }
  const title = courseContent.querySelector('.content-title')?.innerText?.trim() || '';
  const docContent = courseContent.querySelector('.feishu-doc-content, .document-container');
  const text = docContent?.innerText?.trim() || courseContent.innerText?.trim() || '';
  const imgs = Array.from((docContent || courseContent).querySelectorAll('img'))
    .map(i => i.src).filter(s => s && s.startsWith('http'));
  const videos = Array.from((docContent || courseContent).querySelectorAll('video'))
    .map(v => v.src || v.querySelector('source')?.src).filter(Boolean);
  return { title, text, imgs, videos, textLength: text.length };
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
        return { error: `unsupported page type: ${pageType}`, hint: 'supported types: article, opportunity, activity, course' };
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

    // 切换到"中标"tab（如果请求了）
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

    // 预览模式：快速抓摘要
    const mode = ctx.mode || 'list';
    if (mode === 'list') {
      let cards = await scrollToLoad(proxy, targetId, { extractJS: EXTRACT_OPP_CARDS_JS, limit });
      if (bidOnly) cards = cards.filter(c => c.isBid);
      return { listType: 'opportunity', mode: 'list', bidOnly: !!bidOnly, cards, cardCount: cards.length, format: 'json' };
    }

    // 归档模式：滚动加载 → 展开全文 → 提取完整内容+图片
    return this._extractOpportunityArchive(proxy, targetId, limit, ctx);
  },

  // --- 风向标归档模式（支持分页+日期过滤） ---
  async _extractOpportunityArchive(proxy, targetId, limit, ctx) {
    const bidOnly = ctx.url?.includes('filter=bid') || ctx.bidOnly;
    const maxPages = ctx.maxPages || 10;

    let allCards = [];
    let page = 1;
    let shouldStop = false;

    while (page <= maxPages && allCards.length < limit && !shouldStop) {
      // 等待当前页卡片加载
      await proxy.waitFor(targetId, '.post-item', 10000).catch(() => {});
      await sleep(1000);

      // 提取当前页完整数据（innerText 不受 CSS overflow 裁剪影响，无需展开）
      let cards = await proxy.eval(targetId, EXTRACT_OPP_CARDS_ARCHIVE_JS);
      if (!cards || !Array.isArray(cards) || cards.length === 0) break;

      // 过滤中标
      if (bidOnly) cards = cards.filter(c => c.isBid);

      allCards.push(...cards);

      // 如果已经够了就不翻页了
      if (allCards.length >= limit) break;

      // 点击下一页
      const hasNext = await proxy.eval(targetId, `(() => {
        const nextBtn = document.querySelector('.arco-pagination-item-next:not(.arco-pagination-item-disabled)');
        if (nextBtn) { nextBtn.click(); return true; }
        // 回退：找当前 active 页码的下一个兄弟
        const active = document.querySelector('.arco-pagination-item-active');
        const next = active?.nextElementSibling;
        if (next && !next.classList.contains('arco-pagination-item-ellipsis') && next.innerText?.match(/^\\d+$/)) {
          next.click();
          return true;
        }
        return false;
      })()`);

      if (!hasNext) break;
      page++;
      await sleep(2000);
    }

    allCards = allCards.slice(0, limit);

    return {
      listType: 'opportunity',
      mode: 'archive',
      bidOnly: !!bidOnly,
      cards: allCards,
      cardCount: allCards.length,
      pagesScanned: page,
      format: 'json',
    };
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

    // 课程标题
    const courseTitle = await proxy.eval(targetId,
      `document.querySelector('.vc-course-info [class*=title], .vc-course-info h2')?.innerText?.trim() || document.title`
    );

    // 展开所有折叠的 section
    await proxy.eval(targetId, EXPAND_ALL_SECTIONS_JS);
    await sleep(1000);
    const toc = await proxy.eval(targetId, EXTRACT_COURSE_TOC_JS);

    if (!toc || toc.length === 0) return { title: courseTitle, chapters: [], error: 'failed to get TOC' };

    // 构建章节的全局索引（因为不同 section 下可能有同名章节如 "00. 本章概要"）
    // 用全局序号点击，避免名称匹配歧义
    let globalIdx = 0;
    const chapterPlan = [];
    for (const section of toc) {
      for (const ch of section.chapters) {
        chapterPlan.push({ section: section.header, name: ch.name, globalIdx, meta: ch.meta });
        globalIdx++;
      }
    }

    // 逐章点击提取
    const chapters = [];
    for (const plan of chapterPlan) {
      const clicked = await proxy.eval(targetId, `(() => {
        const items = document.querySelectorAll('.vc-chapter-item');
        const target = items[${plan.globalIdx}];
        if (!target) return false;
        target.click();
        return true;
      })()`);

      if (!clicked) {
        chapters.push({ section: plan.section, name: plan.name, error: 'chapter not found in sidebar' });
        continue;
      }

      // 等待内容区更新
      await sleep(2000);

      const content = await proxy.eval(targetId, EXTRACT_COURSE_CONTENT_JS);
      chapters.push({
        section: plan.section,
        name: plan.name,
        meta: plan.meta,
        text: content?.text || '',
        images: content?.imgs || [],
        videos: content?.videos || [],
        textLength: content?.textLength || 0,
      });
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
