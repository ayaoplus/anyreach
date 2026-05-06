#!/usr/bin/env node
// 下载知乎收藏夹的所有 article/answer 为 markdown 文件
// 用法：
//   node scripts/download-zhihu-collection.mjs <collectionUrl> <outDir> [--concurrency 2]

import fs from 'node:fs';
import path from 'node:path';
import { ProxyClient } from '../lib/proxy-client.mjs';
import zhihu from '../adapters/zhihu.mjs';

const PROXY_PORT = Number(process.env.CDP_PROXY_PORT || 3456);

// 解析参数
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: download-zhihu-collection.mjs <collectionUrl> <outDir> [--concurrency 2]');
  process.exit(1);
}
const [collectionUrl, outDirRaw] = args;
const concurrencyIdx = args.indexOf('--concurrency');
const concurrency = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1]) || 2 : 2;
const outDir = outDirRaw.startsWith('~')
  ? path.join(process.env.HOME || '', outDirRaw.slice(1))
  : path.resolve(outDirRaw);

// 把字符串清洗为合法文件名
function safeFilename(s) {
  return String(s || 'untitled')
    .replace(/[\/\\:\*\?"<>\|\n\r\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
}

// 把 unix 秒转 YYYY-MM-DD
function toDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// 渲染单个 item 为 md 字符串
function renderMarkdown(item) {
  const front = ['---'];
  front.push(`type: ${item.type}`);
  if (item.title) front.push(`title: ${JSON.stringify(item.title)}`);
  if (item.questionTitle) front.push(`question: ${JSON.stringify(item.questionTitle)}`);
  if (item.author?.name) front.push(`author: ${JSON.stringify(item.author.name)}`);
  if (item.createdTime) front.push(`created: ${toDate(item.createdTime)}`);
  if (item.updatedTime) front.push(`updated: ${toDate(item.updatedTime)}`);
  if (item.voteupCount != null) front.push(`voteupCount: ${item.voteupCount}`);
  if (item.commentCount != null) front.push(`commentCount: ${item.commentCount}`);
  if (item.sourceUrl) front.push(`source: ${item.sourceUrl}`);
  front.push('---');

  const body = [];
  if (item.type === 'answer') {
    body.push(`# ${item.questionTitle || '(无问题标题)'}`);
    if (item.questionDetailMarkdown) {
      body.push('> ' + item.questionDetailMarkdown.split('\n').join('\n> '));
    }
    body.push(`**回答者：${item.author?.name || ''}**`);
  } else {
    body.push(`# ${item.title || '(无标题)'}`);
    body.push(`**作者：${item.author?.name || ''}**`);
  }
  body.push('');
  body.push(item.markdown || '');

  return front.join('\n') + '\n\n' + body.join('\n');
}

// 主流程
async function main() {
  console.error(`[zhihu] 收藏夹 URL：${collectionUrl}`);
  console.error(`[zhihu] 输出目录：${outDir}`);
  console.error(`[zhihu] 并发：${concurrency}`);

  const proxy = new ProxyClient(PROXY_PORT);

  // 1. 抓取 collection 元信息 + 全部 items 列表
  console.error('[zhihu] 1/3 抓取收藏夹列表...');
  const listTabId = await proxy.newTab(collectionUrl);
  let listResult;
  try {
    listResult = await zhihu._extractCollection(proxy, listTabId, collectionUrl, {});
  } finally {
    await proxy.close(listTabId).catch(() => {});
  }
  if (listResult.error) {
    console.error('[zhihu] 收藏夹抓取失败：', listResult.error);
    process.exit(2);
  }

  const { collection, items } = listResult;
  console.error(`[zhihu] 收藏夹：${collection.title}（共 ${collection.itemCount} 条，本次取 ${items.length} 条）`);

  // 2. 准备目录
  const collectionDir = path.join(outDir, safeFilename(collection.title));
  fs.mkdirSync(collectionDir, { recursive: true });

  // 3. 写 index.md
  const indexLines = [
    `# ${collection.title}`,
    '',
    `- 创建者：${collection.creator}`,
    `- 总条数：${collection.itemCount}`,
    `- 关注数：${collection.followerCount}`,
    `- 收藏夹链接：${collection.url || collectionUrl}`,
    '',
    '## 列表',
    '',
  ];
  items.forEach((it, i) => {
    indexLines.push(`${i + 1}. [${it.kind}] ${it.title}（${it.author}）— ${it.url}`);
  });
  fs.writeFileSync(path.join(collectionDir, 'index.md'), indexLines.join('\n'), 'utf8');

  // 4. 并发抓取所有 item 正文
  console.error(`[zhihu] 2/3 抓取 ${items.length} 条正文...`);
  const total = items.length;
  let done = 0;
  let success = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < total; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (item, idxInBatch) => {
        const globalIdx = i + idxInBatch + 1;
        if (!item.url || !item.kind) return { item, error: 'missing_url_or_kind' };
        const tid = await proxy.newTab(item.url);
        try {
          await proxy.waitFor(tid, 'script#js-initialData', 15000).catch(() => {});
          // 给 SSR 完整渲染一点缓冲（防止 hydration 期间数据被清）
          await new Promise((r) => setTimeout(r, 300));
          const data = item.kind === 'answer'
            ? await zhihu._extractAnswer(proxy, tid)
            : await zhihu._extractArticle(proxy, tid);
          if (!data || data.error) return { item, idx: globalIdx, error: data?.error || 'extract_failed' };
          return { item, idx: globalIdx, data };
        } catch (e) {
          return { item, idx: globalIdx, error: e.message };
        } finally {
          await proxy.close(tid).catch(() => {});
        }
      }),
    );

    for (const r of results) {
      done++;
      if (r.error) {
        failed++;
        failures.push({ url: r.item.url, error: r.error, title: r.item.title });
        console.error(`  [${done}/${total}] FAIL  ${r.item.title?.slice(0, 40)} — ${r.error}`);
        continue;
      }
      const data = r.data;
      const idx = String(r.idx).padStart(3, '0');
      // 文件名：序号_类型_标题
      const titleForFile = data.type === 'answer'
        ? `${data.questionTitle}_${data.author?.name || ''}`
        : data.title;
      const fname = `${idx}_${data.type}_${safeFilename(titleForFile)}.md`;
      const fpath = path.join(collectionDir, fname);
      fs.writeFileSync(fpath, renderMarkdown(data), 'utf8');
      success++;
      console.error(`  [${done}/${total}] OK    ${fname}`);
    }
  }

  // 5. 写失败清单
  if (failures.length) {
    fs.writeFileSync(
      path.join(collectionDir, '_failures.json'),
      JSON.stringify(failures, null, 2),
      'utf8',
    );
  }

  console.error(`[zhihu] 3/3 完成：成功 ${success}，失败 ${failed}，目录 ${collectionDir}`);
}

main().catch((e) => {
  console.error('[zhihu] 致命错误：', e.message);
  process.exit(3);
});
