// AnyReach 生财有术适配器
// 支持页面类型：
//   - article:   帖子详情（完整内容 or 外部链接摘要）
//   - opportunity: 风向标列表（支持 filter=bid 中标筛选）
//   - activity:  航海项目列表
//   - course:    航海手册详情（多章节，逐章提取）
//   - essence:   精华帖列表（?filter=essence，分页，支持 checkpoint/resume）
//
// DOM 关键选择器：
//   帖子内容:    .content-mt
//   风向标卡片:  .post-item
//   航海卡片:    .vc-navigation-card
//   手册侧边栏:  .vc-course-sidebar → .catalogue-section → .vc-chapter-item
//   手册内容:    .content-mt
//   精华帖卡片:  .compact-card → .title-text / .content-preview / .compact-interactions / .tags

import fs from 'node:fs';
import { sleep, downloadMedia, scrollToLoad } from './_utils.mjs';

// =========================================================
// JS extraction snippets (run inside browser via proxy.eval)
// =========================================================

// --- 帖子详情 ---
// DOM 路径（2025 版）：
//   .content-mt > .container > main
//     header                → 作者、身份、日期
//     .title-line           → 精华标签 + 标题
//     .content-container    → ★ 正文（仅此为内容，不含评论）
//     .label-box            → 标签
//     .interactions         → 互动数据
//     .comment-container    → 评论区（排除）
const EXTRACT_ARTICLE_JS = `(() => {
  const main = document.querySelector('.content-mt .container main') || document.querySelector('.content-mt');
  if (!main) return null;

  // 作者 + 身份 + 日期
  const header = main.querySelector('header');
  const author = header?.querySelector('.nickname, [class*=name]')?.innerText?.trim() || '';
  const identity = header?.querySelector('.vc-identity-badge, [class*=identity]')?.innerText?.trim() || '';
  const date = header?.querySelector('[class*=time], [class*=date]')?.innerText?.trim() || '';

  // 标题
  const titleLine = main.querySelector('.title-line');
  const title = titleLine?.querySelector('.title-text, [class*=title]')?.innerText?.trim()
    || titleLine?.innerText?.replace('精华', '')?.trim() || '';

  // ★ 正文（只取 .content-container，排除评论区）
  const contentEl = main.querySelector('.content-container');
  const text = contentEl?.innerText?.trim() || '';

  // 正文中的图片
  const imgs = Array.from((contentEl || main).querySelectorAll('img'))
    .map(i => i.src)
    .filter(s => s && !s.includes('avatar') && !s.includes('emoji'));

  // 外部链接（飞书等，仅从正文区提取）
  const externalLinks = Array.from((contentEl || main).querySelectorAll('a'))
    .map(a => ({ text: a.innerText?.trim()?.slice(0,60), href: a.href }))
    .filter(l => l.href && !l.href.includes('scys.com'));

  // 标签
  const tags = Array.from(main.querySelectorAll('.label-box [class*=tag], .label-box span'))
    .map(t => t.innerText?.trim()).filter(Boolean);

  // 互动数据（按顺序：锚点、点赞、评论、收藏）
  const interactions = main.querySelector('.interactions');
  const counts = Array.from(interactions?.querySelectorAll('.item, .favorite-wrapper') || [])
    .map(el => el.innerText?.trim()).filter(Boolean);

  return { title, author, identity, date, text, imgs, externalLinks, tags, interactionCounts: counts };
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
// 遍历飞书文档 block 结构，直接在浏览器端转为 markdown
const EXTRACT_COURSE_CONTENT_JS = `(() => {
  const courseContent = document.querySelector('.vc-course-content');
  if (!courseContent) {
    const mt = document.querySelector('.content-mt');
    if (!mt) return null;
    return { markdown: mt.innerText?.trim() || '', imgs: [], videos: [], textLength: 0 };
  }

  const title = courseContent.querySelector('.content-title')?.innerText?.trim() || '';
  const docContent = courseContent.querySelector('.feishu-doc-content, .document-container');
  if (!docContent) return { markdown: title ? '# ' + title + '\\n' : '', imgs: [], videos: [], textLength: 0 };

  const mdLines = [];
  const imgs = [];
  const videos = [];
  const items = docContent.querySelectorAll('.vc-doc-item');

  for (const item of items) {
    const inner = item.querySelector(':scope > div');
    if (!inner) continue;

    // --- 标题 ---
    const headerEl = inner.querySelector('.block-header');
    if (headerEl) {
      const levelEl = headerEl.querySelector('[class^=block]');
      const levelClass = levelEl?.className || '';
      // block4→h1, block5→h1, block6→h2, block7→h3, block8→h4, block9→h5
      let level = 2;
      const m = levelClass.match(/block(\\d+)/);
      if (m) level = Math.max(1, Math.min(5, parseInt(m[1]) - 4));
      const text = headerEl.innerText?.trim();
      if (text) mdLines.push('#'.repeat(level) + ' ' + text);
      mdLines.push('');
      continue;
    }

    // --- 图片 ---
    const imgEl = inner.querySelector('.block-image img');
    if (imgEl) {
      const src = imgEl.src;
      if (src && src.startsWith('http')) {
        imgs.push(src);
        mdLines.push('![图片](' + src + ')');
        mdLines.push('');
      }
      continue;
    }

    // --- 视频 ---
    const videoEl = inner.querySelector('video');
    if (videoEl) {
      const src = videoEl.src || videoEl.querySelector('source')?.src;
      if (src) videos.push(src);
      continue;
    }

    // --- 列表项 ---
    const bulletEl = inner.querySelector('.bullet_container');
    if (bulletEl) {
      const listText = bulletEl.querySelector('.list')?.innerText?.trim() || bulletEl.innerText?.replace(/^•\\s*/, '')?.trim();
      if (listText) mdLines.push('- ' + _inlineMarkdown(bulletEl.querySelector('.list') || bulletEl));
      continue;
    }

    // --- 普通文本段落 ---
    const textEl = inner.querySelector('.block-text');
    if (textEl) {
      const text = textEl.innerText?.trim();
      if (!text || textEl.querySelector('.text.blank')) {
        // 空行
        if (mdLines.length > 0 && mdLines[mdLines.length - 1] !== '') mdLines.push('');
        continue;
      }
      mdLines.push(_inlineMarkdown(textEl));
      mdLines.push('');
      continue;
    }
  }

  // 内联样式：加粗
  function _inlineMarkdown(el) {
    const spans = el.querySelectorAll(':scope span.text');
    if (spans.length === 0) return el.innerText?.trim() || '';
    let result = '';
    for (const s of spans) {
      const t = s.textContent || '';
      if (!t || s.classList.contains('blank')) continue;
      if (s.classList.contains('bold')) {
        result += '**' + t + '**';
      } else {
        result += t;
      }
    }
    return result.trim();
  }

  const markdown = mdLines.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { markdown, imgs, videos, textLength: markdown.length };
})()`;

// --- 精华帖列表卡片（.compact-card，用于 ?filter=essence 首页） ---
// DOM 路径：
//   .compact-card > .user-line > .user-info > .avatar-group > span.user-name
//                                           > span.vc-identity-badge（身份）
//                                           > span.time-text（日期）
//              > .content-row > .content-col > .title-line > .vc-essence-badge + .title-text
//                                           > .content-preview（摘要）
//                                           > .meta-line > .compact-interactions .interactions .item×3 + .favorite-wrapper
//                                                       > .tags .tag-item
const EXTRACT_ESSENCE_CARDS_JS = `(() => {
  const cards = document.querySelectorAll('.compact-card');
  return Array.from(cards).map(c => {
    const author = c.querySelector('.user-name')?.innerText?.trim() || '';
    const identity = c.querySelector('.vc-identity-badge')?.innerText?.trim() || '';
    const date = c.querySelector('.time-text')?.innerText?.replace('·', '')?.trim() || '';
    const title = c.querySelector('.title-text')?.innerText?.trim() || '';
    const preview = c.querySelector('.content-preview')?.innerText?.trim() || '';

    // 缩略图
    const thumbnail = c.querySelector('.thumbnail-box img')?.src || '';

    // 互动数据（按顺序：转发/浏览、点赞、评论、收藏）
    // 用 > 限制直接子元素，避免 .favorite-wrapper 内部的 .item 被重复计入
    const interactions = c.querySelectorAll('.compact-interactions .interactions > *');
    const counts = Array.from(interactions).map(el => el.innerText?.trim()).filter(Boolean);

    // 标签
    const tags = Array.from(c.querySelectorAll('.tags .tag-item'))
      .map(t => t.innerText?.trim()).filter(Boolean);

    // 链接：区分站内文章链接和外部资源链接
    const allLinks = Array.from(c.querySelectorAll('a'))
      .map(a => a.href)
      .filter(h => h && h.startsWith('http'));
    const articleLink = allLinks.find(h => h.includes('scys.com/articleDetail')) || '';
    const externalLinks = allLinks.filter(h => !h.includes('scys.com'));

    return { author, identity, date, title, preview, thumbnail, counts, tags, articleLink, externalLinks };
  });
})()`;

// (downloadFile and downloadMedia imported from _utils.mjs)

// =========================================================
// Adapter export
// =========================================================
export default {
  name: 'scys',
  domains: ['scys.com'],
  description: '生财有术：帖子、风向标、航海项目、航海手册、精华帖',

  detect(url) {
    if (url.includes('/articleDetail/')) return 'article';
    if (url.includes('/opportunity')) return 'opportunity';
    if (url.includes('/course/detail/')) return 'course';
    if (url.includes('/activity')) return 'activity';
    // 精华帖：首页带 filter=essence，或首页不带 filter（默认精华）
    if (url.includes('filter=essence') || /scys\.com\/?\?/.test(url) || /scys\.com\/?$/.test(url)) return 'essence';
    return 'unknown';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType } = ctx;
    const limit = ctx.limit || 20;

    // 登录墙检测已在 adapter-runner 层统一处理，此处直接提取内容
    switch (pageType) {
      case 'article':
        return this._extractArticle(proxy, targetId);
      case 'opportunity':
        return this._extractOpportunityList(proxy, targetId, limit, ctx);
      case 'activity':
        return this._extractActivityList(proxy, targetId, limit);
      case 'course':
        return this._extractCourse(proxy, targetId);
      case 'essence':
        return this._extractEssenceList(proxy, targetId, limit, ctx);
      default:
        return { error: `unsupported page type: ${pageType}`, hint: 'supported types: article, opportunity, activity, course, essence' };
    }
  },

  // --- 帖子详情 ---
  // 如果正文含飞书链接，自动跟进提取飞书内容，合并到结果中
  async _extractArticle(proxy, targetId) {
    await proxy.waitFor(targetId, '.content-container, .content-mt', 10000).catch(() => {});
    await sleep(1000);
    const article = await proxy.eval(targetId, EXTRACT_ARTICLE_JS);
    if (!article) return { error: 'failed to extract article' };

    // 检测飞书链接：如果正文有飞书外链，自动提取飞书内容
    const feishuLink = article.externalLinks?.find(l => l.href?.includes('feishu.cn'));
    if (feishuLink) {
      try {
        const feishuTargetId = await proxy.newTab(feishuLink.href);
        await sleep(3000);
        // 尝试加载飞书 adapter 提取内容
        const feishuModule = await import('./feishu.mjs').catch(() => null);
        if (feishuModule?.default?.extract) {
          const feishuResult = await feishuModule.default.extract(proxy, feishuTargetId, {
            url: feishuLink.href,
            pageType: feishuModule.default.detect?.(feishuLink.href) || 'wiki',
          });
          article.feishuContent = feishuResult;
        }
        await proxy.close(feishuTargetId).catch(() => {});
      } catch (e) {
        article.feishuError = e.message;
      }
    }

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

  // --- 精华帖列表（?filter=essence，分页模式） ---
  // ctx 支持：
  //   maxPages     最多翻页数（默认 5，全量传 999）
  //   limit        最大卡片数
  //   resumePage   从第 N 页继续（断点续传，需配合 checkpointFile）
  //   checkpointFile  每页写一次 checkpoint，格式 { lastPage, cards }
  async _extractEssenceList(proxy, targetId, limit, ctx) {
    await proxy.waitFor(targetId, '.compact-card', 12000).catch(() => {});
    await sleep(1000);

    const maxPages = ctx.maxPages || 5;
    const checkpointFile = ctx.checkpointFile || null;

    // --- 断点续传：读取已有 checkpoint ---
    let allCards = [];
    let startPage = 1;
    if (ctx.resumePage && checkpointFile && fs.existsSync(checkpointFile)) {
      try {
        const cp = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
        allCards = cp.cards || [];
        startPage = (cp.lastPage || 0) + 1;
        // 跳转到目标页（用 arco-pagination jumper input），并校验是否跳成功
        if (startPage > 1) {
          const jumped = await proxy.eval(targetId, `(() => {
            const input = document.querySelector('.arco-pagination-jumper input');
            if (!input) return false;
            input.value = '${startPage}';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            return true;
          })()`);
          await sleep(2000);

          // 校验当前 active 页码是否符合预期
          const activePage = await proxy.eval(targetId,
            `parseInt(document.querySelector('.arco-pagination-item-active')?.innerText) || 1`
          );
          if (!jumped || activePage !== startPage) {
            console.warn(`[scys] resume: jump to page ${startPage} failed (landed on ${activePage}), restarting`);
            startPage = 1;
            allCards = [];
          }
        }
      } catch (e) { console.warn(`[scys] checkpoint corrupted, starting fresh: ${e.message}`); }
    }

    let page = startPage;

    while (page <= maxPages && allCards.length < limit) {
      const cards = await proxy.eval(targetId, EXTRACT_ESSENCE_CARDS_JS);
      if (!cards || !Array.isArray(cards) || cards.length === 0) break;

      allCards.push(...cards);

      // 每页写一次 checkpoint（原子写入：先写临时文件再 rename，防止进程崩溃导致文件损坏）
      if (checkpointFile) {
        const tmpFile = checkpointFile + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify({ lastPage: page, cards: allCards }));
        fs.renameSync(tmpFile, checkpointFile);
      }

      if (allCards.length >= limit) break;

      // 翻页：点击下一页
      const hasNext = await proxy.eval(targetId, `(() => {
        const nextBtn = document.querySelector('.arco-pagination-item-next:not(.arco-pagination-item-disabled)');
        if (nextBtn) { nextBtn.click(); return true; }
        return false;
      })()`);

      if (!hasNext) break;
      page++;
      await proxy.eval(targetId, 'window.scrollTo(0,0)');
      await sleep(2000);
    }

    allCards = allCards.slice(0, limit);

    return {
      listType: 'essence',
      cards: allCards,
      cardCount: allCards.length,
      pagesScanned: page,
      format: 'json',
    };
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
        markdown: content?.markdown || '',
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
    const beforeTabs = await proxy.fetch('/targets');
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
    const afterTabs = await proxy.fetch('/targets');
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
