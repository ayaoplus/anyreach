// AnyReach 知乎适配器
// 支持三种页面类型：
//   - article: 专栏文章 (zhuanlan.zhihu.com/p/<id>)
//   - answer:  问答回答 (www.zhihu.com/question/<qid>/answer/<aid>)
//   - collection: 收藏夹列表页 (www.zhihu.com/collection/<id>)
//
// 提取策略：
//   - article / answer：从 <script id="js-initialData"> 读取 SSR 注入的实体数据，
//     拿到结构化 HTML 内容后在浏览器内转 Markdown。这是最稳的路径，避免依赖
//     渲染后的 DOM（隐藏图片占位、懒加载、虚拟列表）。
//   - collection：SSR 只暴露 favlist 元信息，正文项依赖按需渲染，所以走分页爬取，
//     从 DOM 取每个 item 的链接、标题、作者，再交给 article/answer 二次抓取。
//
// 已知坑：
//   - <img src=...> 是 SVG 占位符，真实图片在外层 <noscript> 包裹的 <img> 或 data-original 属性。
//   - 站内外链统一指向 https://link.zhihu.com/?target=<encoded>，需要解码。
//   - 收藏夹使用 ?page=N 翻页（每页 20 条）。

import { sleep } from './_utils.mjs';

// 在浏览器内执行的公共脚本：HTML→Markdown 转换 + 链接解码 + 图片真实地址提取
const BROWSER_CONVERT_JS = String.raw`
function decodeZhihuLink(href) {
  if (!href) return '';
  // 站内外链格式：https://link.zhihu.com/?target=<urlEncoded>
  try {
    const u = new URL(href, location.origin);
    if (/(^|\.)link\.zhihu\.com$/.test(u.hostname)) {
      const target = u.searchParams.get('target');
      if (target) return target;
    }
    return u.href;
  } catch {
    return href;
  }
}

function realImgSrc(img) {
  if (!img) return '';
  // 优先级：data-original（高清原图） > data-actualsrc（中等） > src（占位符）
  const original = img.getAttribute && img.getAttribute('data-original');
  if (original && !/^data:/.test(original)) return original;
  const actual = img.getAttribute && img.getAttribute('data-actualsrc');
  if (actual && !/^data:/.test(actual)) return actual;
  const src = img.getAttribute && img.getAttribute('src');
  if (src && !/^data:/.test(src)) return src;
  return '';
}

function escapeMd(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/([\`*_\[\]<>])/g, '\\$1');
}

function inlineMd(node) {
  if (!node) return '';
  if (node.nodeType === Node.TEXT_NODE) return escapeMd(node.textContent || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') {
    const src = realImgSrc(node);
    return src ? '![](' + src + ')' : '';
  }
  if (tag === 'NOSCRIPT') {
    // <noscript> 内通常有真实 <img>，作为图片节点处理
    const tmp = document.createElement('div');
    tmp.innerHTML = node.textContent || '';
    const img = tmp.querySelector('img');
    if (img) {
      const src = realImgSrc(img);
      return src ? '![](' + src + ')' : '';
    }
    return '';
  }
  let inner = Array.from(node.childNodes).map(inlineMd).join('');
  if (tag === 'A') {
    const href = decodeZhihuLink(node.getAttribute('href') || '');
    const label = inner.trim() || href;
    return href ? '[' + label + '](' + href + ')' : label;
  }
  if (tag === 'CODE' && node.parentElement?.tagName !== 'PRE') {
    return '\`' + (node.textContent || '').replace(/\`/g, '\\\`') + '\`';
  }
  if (tag === 'B' || tag === 'STRONG') return inner.trim() ? '**' + inner.trim() + '**' : '';
  if (tag === 'I' || tag === 'EM') return inner.trim() ? '*' + inner.trim() + '*' : '';
  if (tag === 'SUP') return inner.trim() ? '^' + inner.trim() + '^' : '';
  if (tag === 'SUB') return inner.trim() ? '~' + inner.trim() + '~' : '';
  if (tag === 'U') return inner;
  return inner;
}

function blockMd(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) {
    if (node?.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.trim();
      return t ? escapeMd(t) : '';
    }
    return '';
  }
  const tag = node.tagName;
  if (tag === 'P') return inlineMd(node).trim();
  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return '#'.repeat(level) + ' ' + inlineMd(node).trim();
  }
  if (tag === 'BLOCKQUOTE') {
    const inner = Array.from(node.children).map(blockMd).filter(Boolean).join('\n\n')
      || inlineMd(node).trim();
    return inner.split('\n').map(l => '> ' + l).join('\n');
  }
  if (tag === 'UL' || tag === 'OL') {
    const ordered = tag === 'OL';
    return Array.from(node.children)
      .filter(c => c.tagName === 'LI')
      .map((li, i) => {
        const marker = ordered ? (i + 1) + '. ' : '- ';
        const text = inlineMd(li).trim().split('\n').join('\n  ');
        return marker + text;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (tag === 'PRE') {
    const code = node.textContent || '';
    return '\`\`\`\n' + code.replace(/\n+$/, '') + '\n\`\`\`';
  }
  if (tag === 'FIGURE') {
    // <figure> 通常包裹图片，里面有 noscript+占位 img 或 video
    const img = node.querySelector('img:not([src^="data:"])') || node.querySelector('noscript');
    let src = '';
    if (img?.tagName === 'IMG') src = realImgSrc(img);
    else if (img?.tagName === 'NOSCRIPT') {
      const tmp = document.createElement('div');
      tmp.innerHTML = img.textContent || '';
      src = realImgSrc(tmp.querySelector('img'));
    }
    if (!src) {
      // 尝试从所有 img 中找一张非 data 的
      for (const im of node.querySelectorAll('img')) {
        const s = realImgSrc(im);
        if (s) { src = s; break; }
      }
    }
    const caption = node.querySelector('figcaption')?.innerText?.trim() || '';
    if (src) return '![' + escapeMd(caption) + '](' + src + ')';
    return inlineMd(node).trim();
  }
  if (tag === 'HR') return '---';
  if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE') {
    const blocks = Array.from(node.children).map(blockMd).filter(Boolean);
    if (blocks.length) return blocks.join('\n\n');
    return inlineMd(node).trim();
  }
  return inlineMd(node).trim();
}

function htmlToMarkdown(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const blocks = Array.from(tmp.children).map(blockMd).filter(Boolean);
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function readInitialData() {
  const s = document.querySelector('script#js-initialData');
  if (!s) return null;
  try {
    return JSON.parse(s.textContent).initialState;
  } catch {
    return null;
  }
}
`;

// 文章页提取脚本：返回 article entity + markdown
const EXTRACT_ARTICLE_JS = `(() => {
  ${BROWSER_CONVERT_JS}
  const data = readInitialData();
  if (!data) return { error: 'no_initial_data' };
  const articles = data.entities?.articles || {};
  const keys = Object.keys(articles);
  if (!keys.length) return { error: 'no_article_entity' };
  const a = articles[keys[0]];
  const author = a.author || {};
  const column = a.column || null;
  return {
    type: 'article',
    id: keys[0],
    title: a.title || '',
    author: { name: author.name || '', headline: author.headline || '', urlToken: author.urlToken || '' },
    column: column ? { title: column.title, url: column.url } : null,
    createdTime: a.created || a.createdTime || 0,
    updatedTime: a.updated || a.updatedTime || 0,
    voteupCount: a.voteupCount || 0,
    commentCount: a.commentCount || 0,
    excerpt: a.excerpt || '',
    sourceUrl: location.href,
    markdown: htmlToMarkdown(a.content || ''),
  };
})()`;

// 回答页提取脚本：返回 answer entity + question + markdown
const EXTRACT_ANSWER_JS = `(() => {
  ${BROWSER_CONVERT_JS}
  const data = readInitialData();
  if (!data) return { error: 'no_initial_data' };
  const answers = data.entities?.answers || {};
  const questions = data.entities?.questions || {};
  const aKeys = Object.keys(answers);
  if (!aKeys.length) return { error: 'no_answer_entity' };
  const a = answers[aKeys[0]];
  const qKey = String(a.question?.id || Object.keys(questions)[0] || '');
  const q = questions[qKey] || a.question || {};
  const author = a.author || {};
  return {
    type: 'answer',
    id: aKeys[0],
    questionId: qKey,
    questionTitle: q.title || '',
    questionDetailMarkdown: htmlToMarkdown(q.detail || ''),
    author: { name: author.name || '', headline: author.headline || '', urlToken: author.urlToken || '' },
    createdTime: a.createdTime || a.created || 0,
    updatedTime: a.updatedTime || a.updated || 0,
    voteupCount: a.voteupCount || 0,
    commentCount: a.commentCount || 0,
    excerpt: a.excerpt || '',
    sourceUrl: location.href,
    markdown: htmlToMarkdown(a.content || ''),
  };
})()`;

// 收藏夹页提取脚本：返回 favlist 元信息 + 当前页 items
const EXTRACT_COLLECTION_PAGE_JS = `(() => {
  ${BROWSER_CONVERT_JS}
  const data = readInitialData();
  let meta = null;
  if (data) {
    const fav = data.entities?.favlists || {};
    const fkey = Object.keys(fav)[0];
    if (fkey) {
      const f = fav[fkey];
      meta = {
        id: f.id || fkey,
        title: f.title || '',
        description: f.description || '',
        itemCount: f.itemCount || 0,
        followerCount: f.followerCount || 0,
        creator: f.creator?.name || '',
        creatorUrlToken: f.creator?.urlToken || '',
        url: f.url || location.href,
        isPublic: !!f.isPublic,
        createdTime: f.createdTime || 0,
        updatedTime: f.updatedTime || 0,
      };
    }
  }
  // 解析当前页 items
  const itemNodes = document.querySelectorAll('.CollectionDetailPageItem');
  const items = Array.from(itemNodes).map((it) => {
    const links = Array.from(it.querySelectorAll('a[href]')).map((a) => a.href).filter(Boolean);
    const contentLink = links.find((u) => /\\/answer\\/\\d+/.test(u))
      || links.find((u) => /zhuanlan\\.zhihu\\.com\\/p\\//.test(u))
      || links.find((u) => /\\/p\\//.test(u))
      || null;
    let kind = null;
    if (contentLink && /\\/answer\\/\\d+/.test(contentLink)) kind = 'answer';
    else if (contentLink && /(zhuanlan\\.zhihu\\.com\\/p\\/|\\/p\\/)/.test(contentLink)) kind = 'article';
    const titleEl = it.querySelector('h2 a, .ContentItem-title a, h2');
    const authorEl = it.querySelector('.AuthorInfo-name, .UserLink-link, .AuthorInfo .UserLink');
    return {
      kind,
      url: contentLink,
      title: titleEl?.innerText?.trim() || '',
      author: authorEl?.innerText?.trim() || '',
    };
  }).filter((x) => x.url);
  // 总页数：从分页文本推断（文本形如 "1234...7下一页"）
  const pagiText = document.querySelector('.Pagination, [class*=Pagination]')?.innerText || '';
  return { meta, items, pagiText };
})()`;

// --- adapter 主体 ---

export default {
  name: 'zhihu',
  domains: ['zhihu.com', 'zhuanlan.zhihu.com'],
  description: 'Zhihu article/answer/collection extraction with HTML→Markdown',

  detect(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return 'unknown'; }
    const host = parsed.hostname;
    const path = parsed.pathname;
    if (host === 'zhuanlan.zhihu.com' && /^\/p\/\w+/.test(path)) return 'article';
    if (/\/p\/\w+/.test(path) && host.endsWith('zhihu.com')) return 'article';
    if (/^\/question\/\d+\/answer\/\d+/.test(path)) return 'answer';
    if (/^\/collection\/\d+/.test(path)) return 'collection';
    return 'unknown';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType, url } = ctx;
    if (pageType === 'article') return this._extractArticle(proxy, targetId);
    if (pageType === 'answer') return this._extractAnswer(proxy, targetId);
    if (pageType === 'collection') return this._extractCollection(proxy, targetId, url, ctx);
    return { error: `unsupported page type: ${pageType}` };
  },

  async _extractArticle(proxy, targetId) {
    await proxy.waitFor(targetId, 'script#js-initialData', 15000).catch(() => {});
    const result = await proxy.eval(targetId, EXTRACT_ARTICLE_JS);
    if (!result || result.error) return result || { error: 'extract_failed' };
    return { ...result, format: 'markdown' };
  },

  async _extractAnswer(proxy, targetId) {
    await proxy.waitFor(targetId, 'script#js-initialData', 15000).catch(() => {});
    const result = await proxy.eval(targetId, EXTRACT_ANSWER_JS);
    if (!result || result.error) return result || { error: 'extract_failed' };
    return { ...result, format: 'markdown' };
  },

  // 翻页爬取整个收藏夹的 item 列表（不抓正文，正文交给 fetchItem）
  async _extractCollection(proxy, targetId, _url, ctx) {
    const maxPages = ctx.maxPages || 50;
    const limit = ctx.limit || Infinity;

    await proxy.waitFor(targetId, '.CollectionDetailPageItem', 15000).catch(() => {});
    await sleep(800);

    const firstPage = await proxy.eval(targetId, EXTRACT_COLLECTION_PAGE_JS);
    if (!firstPage?.meta) return { error: 'no_collection_meta' };

    const meta = firstPage.meta;
    const allItems = firstPage.items.slice(0, limit);
    const seen = new Set(allItems.map((i) => i.url));

    // 计算总页数：itemCount/20 上取整，封顶 maxPages
    const totalPages = Math.min(maxPages, Math.max(1, Math.ceil((meta.itemCount || 0) / 20)));

    for (let page = 2; page <= totalPages && allItems.length < limit; page++) {
      const pageUrl = `https://www.zhihu.com/collection/${meta.id}?page=${page}`;
      await proxy.navigate(targetId, pageUrl);
      await proxy.waitFor(targetId, '.CollectionDetailPageItem', 15000).catch(() => {});
      await sleep(800);
      const data = await proxy.eval(targetId, EXTRACT_COLLECTION_PAGE_JS);
      if (!data?.items?.length) break;
      let added = 0;
      for (const item of data.items) {
        if (item.url && !seen.has(item.url)) {
          seen.add(item.url);
          allItems.push(item);
          added++;
          if (allItems.length >= limit) break;
        }
      }
      if (added === 0) break; // 防止死循环
    }

    return {
      type: 'collection',
      collection: meta,
      items: allItems,
      itemCount: allItems.length,
      format: 'json',
    };
  },

  // 批量抓取收藏夹 items 的正文。每条 item 在新 tab 中提取。
  async fetchItems(proxy, items, opts = {}) {
    const concurrency = opts.concurrency || 2;
    const interBatchDelay = opts.interBatchDelay || 1500;
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (item) => {
          if (!item.url || !item.kind) return { ...item, error: 'no_url_or_kind' };
          const tid = await proxy.newTab(item.url);
          try {
            await proxy.waitFor(tid, 'script#js-initialData', 15000).catch(() => {});
            const js = item.kind === 'answer' ? EXTRACT_ANSWER_JS : EXTRACT_ARTICLE_JS;
            const data = await proxy.eval(tid, js);
            if (!data || data.error) return { ...item, error: data?.error || 'extract_failed' };
            return { ...item, ...data };
          } catch (e) {
            return { ...item, error: e.message };
          } finally {
            await proxy.close(tid).catch(() => {});
          }
        }),
      );
      results.push(...batchResults);
      if (i + concurrency < items.length) await sleep(interBatchDelay);
    }
    return results;
  },
};
