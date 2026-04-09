#!/usr/bin/env node
// collect-urls.mjs — 从列表抓取结果中提取内容 URL，供 crawler.mjs 使用
//
// 读取精华帖/风向标等列表适配器的 JSON 输出，提取：
//   - scys.com 站内文章链接（articleLink）
//   - 外部资源链接（externalLinks：飞书 wiki/docx、zsxq 等）
//
// 用法：
//   node scripts/collect-urls.mjs --input result.json --output urls.txt [options]
//   node scripts/adapter-runner.mjs run "https://scys.com/?filter=essence" \
//     --ctx '{"maxPages":10}' | node scripts/collect-urls.mjs --output urls.txt
//
// 参数：
//   --input <file>      输入 JSON 文件（默认读 stdin）
//   --output <file>     输出 URL 列表文件（默认 stdout）
//   --include-external  包含外部链接（飞书等），默认 true
//   --only-external     只输出外部链接，跳过站内文章链接
//   --only-internal     只输出 scys.com 站内文章链接
//   --filter <domain>   只保留包含指定域名的 URL（可重复，如 --filter feishu.cn）
//   --dedup             去重（默认开启）

import fs from 'node:fs';
import readline from 'node:readline';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: null,
    output: null,
    includeExternal: true,
    onlyExternal: false,
    onlyInternal: false,
    filters: [],
    dedup: true,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--input':        opts.input = args[++i]; break;
      case '--output':       opts.output = args[++i]; break;
      case '--include-external': opts.includeExternal = true; break;
      case '--only-external':    opts.onlyExternal = true; break;
      case '--only-internal':    opts.onlyInternal = true; break;
      case '--filter':       opts.filters.push(args[++i]); break;
      case '--no-dedup':     opts.dedup = false; break;
      case '--help': case '-h': printUsage(); process.exit(0);
    }
  }
  return opts;
}

function printUsage() {
  process.stderr.write(`
collect-urls — 从列表抓取结果提取内容 URL

用法:
  node scripts/collect-urls.mjs [--input result.json] [--output urls.txt]
  node scripts/adapter-runner.mjs run "URL" --ctx '{"maxPages":10}' | node scripts/collect-urls.mjs --output urls.txt

参数:
  --input <file>      输入 JSON 文件（默认 stdin）
  --output <file>     输出 URL 列表（默认 stdout）
  --only-external     只输出外部链接（飞书等）
  --only-internal     只输出 scys.com 站内文章链接
  --filter <domain>   只保留包含该域名的 URL（可重复）
  --no-dedup          不去重
`.trim() + '\n');
}

// 从单张卡片中提取所有内容 URL
function extractCardUrls(card, opts) {
  const urls = [];

  // 站内文章链接
  if (!opts.onlyExternal && card.articleLink) {
    urls.push(card.articleLink);
  }

  // 外部资源链接（飞书 wiki/docx、zsxq 等）
  if (!opts.onlyInternal && card.externalLinks?.length > 0) {
    urls.push(...card.externalLinks);
  }

  return urls;
}

// 从适配器结果（可能是列表或单篇）中提取所有 URL
function extractUrls(result, opts) {
  const urls = [];

  // 精华帖 / 风向标 / 航海等列表类型
  if (result.cards && Array.isArray(result.cards)) {
    for (const card of result.cards) {
      urls.push(...extractCardUrls(card, opts));
    }
  }

  // NDJSON 中每行可能是 { url, data: { cards: [...] } }
  if (result.data?.cards) {
    for (const card of result.data.cards) {
      urls.push(...extractCardUrls(card, opts));
    }
  }

  return urls;
}

async function readInput(inputFile) {
  if (inputFile) {
    return fs.readFileSync(inputFile, 'utf8');
  }
  // 从 stdin 读取
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs();

  const raw = await readInput(opts.input);
  if (!raw.trim()) {
    process.stderr.write('[collect-urls] 输入为空\n');
    process.exit(1);
  }

  // 解析：先尝试整体解析（单个 JSON），失败则按行解析（NDJSON）
  let allUrls = [];
  let parsed = false;
  try {
    const obj = JSON.parse(raw);
    allUrls.push(...extractUrls(obj, opts));
    parsed = true;
  } catch { /* 不是完整 JSON，尝试 NDJSON */ }

  if (!parsed) {
    for (const line of raw.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        allUrls.push(...extractUrls(obj, opts));
      } catch { /* 跳过无法解析的行 */ }
    }
  }

  // 过滤指定域名
  if (opts.filters.length > 0) {
    allUrls = allUrls.filter(url => opts.filters.some(f => url.includes(f)));
  }

  // 过滤空值和非 http URL
  allUrls = allUrls.filter(url => url && url.startsWith('http'));

  // 去重
  if (opts.dedup) {
    allUrls = [...new Set(allUrls)];
  }

  if (allUrls.length === 0) {
    process.stderr.write('[collect-urls] 未找到任何 URL\n');
    process.exit(0);
  }

  const output = allUrls.join('\n') + '\n';

  if (opts.output) {
    fs.writeFileSync(opts.output, output, 'utf8');
    process.stderr.write(`[collect-urls] 输出 ${allUrls.length} 个 URL → ${opts.output}\n`);
  } else {
    process.stdout.write(output);
    process.stderr.write(`[collect-urls] 共 ${allUrls.length} 个 URL\n`);
  }
}

main().catch(e => {
  process.stderr.write(`[collect-urls] 错误: ${e.message}\n`);
  process.exit(1);
});
