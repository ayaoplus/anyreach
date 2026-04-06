// AnyReach 飞书适配器
// 通过 window.DATA.clientVars.data 读取文档 block 数据
// 长文档支持：通过 CDP 接口从 Web Worker 获取后续 slice 的 block 数据
//
// 飞书文档数据结构：
//   - block_map: 所有 block 的 id → data 映射
//   - block_sequence: 顶层 block 的渲染顺序
//   - 每个 block 的 children 数组定义嵌套结构
//   - has_more: 是否有后续 slice 未加载
//
// 长文档加载机制：
//   飞书对长文档做分 slice 加载。第一个 slice 嵌在 HTML 中（SSR），
//   后续 slice 由 docxClientvarFetchManager 通过 Web Worker 异步获取。
//   Worker 请求 /space/api/docx/pages/client_vars 接口加载剩余 block。
//   我们通过 CDP 的 Worker session 重放这些请求来获取完整数据。

import { sleep } from './_utils.mjs';

// 等待飞书文档数据加载完成
const WAIT_DATA_JS = `new Promise((resolve) => {
  let tries = 0;
  const check = () => {
    const d = window.DATA?.clientVars?.data;
    if (d?.block_map && d?.block_sequence?.length > 0) {
      return resolve({ ready: true, blocks: d.block_sequence.length, hasMore: d.has_more });
    }
    if (++tries > 30) return resolve({ ready: false, timeout: true });
    setTimeout(check, 500);
  };
  check();
})`;

// 获取文档结构信息（block_map + children 树）
const GET_DOC_STRUCTURE_JS = `(() => {
  const d = window.DATA?.clientVars?.data;
  if (!d) return null;
  return JSON.stringify({
    block_map: d.block_map,
    root_id: d.block_sequence?.[0],
    has_more: d.has_more,
  });
})()`;

// 提取文档元信息
const EXTRACT_META_JS = `(() => {
  const meta = window.DATA?.meta;
  const d = window.DATA?.clientVars?.data;
  return {
    title: d?.block_map?.[d?.block_sequence?.[0]]?.data?.text?.initialAttributedTexts?.text?.['0']?.trim() || document.title,
    author: meta?.author?.name || meta?.creator?.name || null,
    createTime: meta?.create_time || null,
    updateTime: meta?.update_time || null,
    blockCount: d?.block_sequence?.length || 0,
    hasMore: d?.has_more || false,
  };
})()`;

// 从 block 数据提取文本，处理加粗
function getBlockText(block) {
  const iat = block?.data?.text?.initialAttributedTexts || {};
  const text = (iat.text?.['0'] || '').trim();
  if (!text) return '';

  // 检查是否整段加粗
  const apool = block?.data?.text?.apool?.numToAttrib || {};
  const hasBold = Object.values(apool).some(v => v[0] === 'bold' && v[1] === 'true');
  if (hasBold) {
    const attribs = iat.attribs?.['0'] || '';
    // 如果 attribs 中所有字符都带 bold 属性，整段加粗
    const boldIdx = Object.entries(apool).find(([, v]) => v[0] === 'bold')?.[0];
    if (boldIdx !== undefined && attribs.includes(`*${boldIdx}`) && attribs.split('+').length <= 2) {
      return `**${text}**`;
    }
  }
  return text;
}

// 图片 token 转 CDN URL
function imgTokenToUrl(token, blockId) {
  if (!token) return '';
  return `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/${token}/?fallback_source=1&height=1280&mount_node_token=${blockId}&mount_point=docx_image`;
}

// emoji_id 转 unicode emoji
const EMOJI_MAP = {
  'thought_balloon': '💭', 'white_check_mark': '✅', 'bulb': '💡',
  'warning': '⚠️', 'memo': '📝', 'star': '⭐', 'fire': '🔥',
  'rocket': '🚀', 'pushpin': '📌', 'bell': '🔔', 'link': '🔗',
  'heart': '❤️', 'thumbsup': '👍', 'eyes': '👀', 'question': '❓',
  'exclamation': '❗', 'information_source': 'ℹ️', 'x': '❌',
};

function emojiIdToChar(emojiId, emojiValue) {
  if (EMOJI_MAP[emojiId]) return EMOJI_MAP[emojiId];
  // 用 unicode codepoint 回退
  if (emojiValue) {
    try { return String.fromCodePoint(parseInt(emojiValue, 16)); } catch { /* ignore */ }
  }
  return '';
}

// 递归遍历 block 树，生成 markdown
function blocksToMarkdown(allBlocks, rootId) {
  const lines = [];
  const images = [];
  let orderedCounter = 1;
  let lastType = '';

  // quoteDepth 控制 blockquote 嵌套层级
  function traverse(blockId, quoteDepth = 0) {
    const block = allBlocks[blockId];
    if (!block?.data) return;

    const type = block.data.type;
    const text = getBlockText(block);
    const children = block.data.children || [];
    const imgToken = block.data.image?.token || '';
    const prefix = quoteDepth > 0 ? '> '.repeat(quoteDepth) : '';

    // 有序列表计数器重置
    if (type !== 'ordered' && lastType === 'ordered') orderedCounter = 1;

    switch (type) {
      case 'page':
        if (text) { lines.push(`# ${text}`); lines.push(''); }
        break;
      case 'heading1':
        if (text) { lines.push(`\n${prefix}## ${text}`); lines.push(''); }
        break;
      case 'heading2':
        if (text) { lines.push(`\n${prefix}## ${text}`); lines.push(''); }
        break;
      case 'heading3':
        if (text) { lines.push(`\n${prefix}### ${text}`); lines.push(''); }
        break;
      case 'heading4':
        if (text) { lines.push(`\n${prefix}#### ${text}`); lines.push(''); }
        break;
      case 'heading5':
        if (text) { lines.push(`\n${prefix}##### ${text}`); lines.push(''); }
        break;
      case 'heading6':
      case 'heading7':
      case 'heading8':
      case 'heading9':
        if (text) { lines.push(`\n${prefix}##### ${text}`); lines.push(''); }
        break;
      case 'ordered':
        if (text) { lines.push(`${prefix}${orderedCounter}. ${text}`); orderedCounter++; }
        break;
      case 'bullet':
        if (text) lines.push(`${prefix}- ${text}`);
        break;
      case 'todo': {
        const checked = block.data.done ? 'x' : ' ';
        if (text) lines.push(`${prefix}- [${checked}] ${text}`);
        break;
      }
      case 'quote_container':
        // quote_container 本身没有文本，内容在 children 中
        // children 需要用 > 前缀渲染
        for (const childId of children) {
          traverse(childId, quoteDepth + 1);
        }
        lines.push('');
        return; // 已处理 children，跳过下方的通用 children 递归
      case 'callout': {
        // 高亮提示块：emoji + 背景色 + children
        const emoji = emojiIdToChar(block.data.emoji_id, block.data.emoji_value);
        if (emoji) lines.push(`${prefix}> ${emoji}`);
        // children 用 > 前缀渲染
        for (const childId of children) {
          traverse(childId, quoteDepth + 1);
        }
        lines.push('');
        return;
      }
      case 'code':
        if (text) {
          lines.push(`${prefix}\`\`\``);
          lines.push(`${prefix}${text}`);
          lines.push(`${prefix}\`\`\``);
          lines.push('');
        }
        break;
      case 'divider':
        lines.push(`${prefix}---`); lines.push('');
        break;
      case 'image':
        if (imgToken) {
          const url = imgTokenToUrl(imgToken, blockId);
          images.push(url);
          lines.push(`${prefix}![图片](${url})`); lines.push('');
        }
        break;
      case 'iframe': {
        // 嵌入内容：视频、妙记、网页等
        const comp = block.data.iframe?.component || {};
        const originalUrl = comp.original_text ? decodeURIComponent(comp.original_text) : comp.url || '';
        const iframeType = comp.type || 'embed';
        const typeLabel = iframeType.includes('minutes') ? '📹 妙记' :
          iframeType.includes('video') ? '📹 视频' :
          iframeType.includes('bitable') ? '📊 多维表格' : '🔗 嵌入';
        if (originalUrl) {
          lines.push(`${prefix}> ${typeLabel}: ${originalUrl}`);
          lines.push('');
        }
        break;
      }
      case 'base_refer':
        // 多维表格引用，标记跳过
        lines.push(`${prefix}> 📊 *[多维表格引用]*`);
        lines.push('');
        break;
      case 'isv':
        // 第三方应用块（如目录导航），跳过
        break;
      case 'table':
      case 'table_cell':
        // table 内容通过 children 递归处理
        break;
      case 'grid':
      case 'grid_column':
        // grid 布局通过 children 递归处理
        break;
      default:
        if (text) { lines.push(`${prefix}${text}`); lines.push(''); }
    }

    lastType = type;

    // 递归处理 children（quote_container 和 callout 已在上面单独处理）
    for (const childId of children) {
      traverse(childId, quoteDepth);
    }
  }

  traverse(rootId, 0);

  const markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, images };
}

// 通过刷新页面 + autoAttach 捕获 Worker，从 Worker 获取后续 slice 的 block 数据
// 必须在页面加载前设置 autoAttach，否则已存在的 Worker 不会被捕获
async function fetchMissingBlocks(proxy, targetId, pageUrl) {
  const proxyBase = `http://127.0.0.1:${proxy.port}`;

  // 1. 设置 autoAttach + waitForDebugger（Worker 创建时暂停，proxy 自动启用 Network 后恢复）
  await cdpCall(proxyBase, targetId, 'Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
  });

  // 2. 开始事件收集
  const colResp = await fetch(`${proxyBase}/events/start?target=${targetId}`, {
    method: 'POST', body: JSON.stringify({ maxEvents: 100 }),
  }).then(r => r.json());
  const collectorId = colResp.collectorId;

  // 3. 刷新页面，触发 Worker 重新创建
  await fetch(`${proxyBase}/navigate?target=${targetId}&url=${encodeURIComponent(pageUrl)}`).then(r => r.json());

  // 4. 等待页面和 Worker 加载完成
  await sleep(10000);

  // 5. 从事件中找到 Worker session
  const events = await fetch(`${proxyBase}/events/get?id=${collectorId}`).then(r => r.json());
  await fetch(`${proxyBase}/events/stop?id=${collectorId}`).then(r => r.json());

  let workerSessionId = null;
  for (const e of events.events || []) {
    if (e.method === 'Target.attachedToTarget') {
      const info = e.params?.targetInfo || {};
      if (info.type === 'worker') {
        workerSessionId = e.params.sessionId;
        break;
      }
    }
  }

  if (!workerSessionId) return null;

  // 6. 从 Worker 的 performance entries 获取 API URL，重新 fetch 获取 block 数据
  const result = await cdpCall(proxyBase, null, 'Runtime.evaluate', {
    expression: `(async () => {
      const urls = performance.getEntriesByType("resource").map(e => e.name);
      const allBlocks = {};
      for (const url of urls) {
        try {
          const resp = await fetch(url);
          const data = await resp.json();
          Object.assign(allBlocks, data?.data?.block_map || {});
        } catch {}
      }
      return JSON.stringify(allBlocks);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, workerSessionId);

  if (!result?.value) return null;

  try {
    return JSON.parse(result.value);
  } catch {
    return null;
  }
}

// 发送 CDP 命令的辅助函数
async function cdpCall(proxyBase, targetId, method, params, sessionId) {
  const query = sessionId ? `session=${sessionId}` : `target=${targetId}`;
  const resp = await fetch(`${proxyBase}/cdp?${query}`, {
    method: 'POST',
    body: JSON.stringify({ method, params }),
  });
  const data = await resp.json();
  return data?.result ?? data;
}

export default {
  name: 'feishu',
  domains: ['feishu.cn', 'larksuite.com'],
  description: '飞书知识库/云文档内容提取（window.DATA + Worker block 补全）',

  detect(url) {
    if (url.includes('/wiki/')) return 'wiki';
    if (url.includes('/docx/')) return 'docx';
    if (url.includes('/sheets/')) return 'sheets';
    if (url.includes('/minutes/')) return 'minutes';
    return 'unknown';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType } = ctx;

    // sheets/minutes 暂不支持
    if (pageType === 'sheets' || pageType === 'minutes') {
      return {
        title: await proxy.eval(targetId, 'document.title'),
        content: null,
        format: 'unsupported',
        message: `飞书 ${pageType} 暂不支持结构化提取，请使用通用 CDP 模式`,
      };
    }

    // 等待 window.DATA 加载
    const waitResult = await proxy.eval(targetId, WAIT_DATA_JS);
    if (!waitResult?.ready) {
      return {
        title: await proxy.eval(targetId, 'document.title'),
        content: null,
        error: '文档数据未能加载（window.DATA 不可用）',
      };
    }

    // 获取元信息
    const meta = await proxy.eval(targetId, EXTRACT_META_JS);

    // 获取 block_map 和文档结构
    let structRaw = await proxy.eval(targetId, GET_DOC_STRUCTURE_JS);
    if (!structRaw) {
      return { title: meta?.title || '', content: null, error: 'block_map 不可用' };
    }

    let struct;
    try {
      struct = JSON.parse(structRaw);
    } catch {
      return { title: meta?.title || '', content: null, error: 'block_map 解析失败' };
    }

    let allBlocks = struct.block_map || {};
    let rootId = struct.root_id;
    let workerBlockCount = 0;

    // 如果有后续 slice，刷新页面后从 Worker 获取完整数据
    if (struct.has_more) {
      try {
        const workerBlocks = await fetchMissingBlocks(proxy, targetId, ctx.url);
        if (workerBlocks) {
          workerBlockCount = Object.keys(workerBlocks).length;
          // Worker 返回的数据包含所有 slice，可能与初始数据重叠
          allBlocks = { ...allBlocks, ...workerBlocks };

          // 刷新后 window.DATA 也更新了，重新读取以获取最新的 block_map
          const newStructRaw = await proxy.eval(targetId, GET_DOC_STRUCTURE_JS);
          if (newStructRaw) {
            try {
              const newStruct = JSON.parse(newStructRaw);
              // 合并刷新后的主线程数据
              allBlocks = { ...allBlocks, ...newStruct.block_map };
              rootId = newStruct.root_id || rootId;
            } catch { /* 用已有数据 */ }
          }
        }
      } catch (e) {
        // Worker 获取失败，用已有数据继续（部分内容）
        console.error('[feishu] Worker block fetch failed:', e.message);
      }
    }

    // 递归遍历 block 树生成 markdown
    const { markdown, images } = blocksToMarkdown(allBlocks, rootId);

    return {
      title: meta?.title || '',
      content: markdown,
      format: 'markdown',
      meta: {
        author: meta?.author,
        createTime: meta?.createTime,
        updateTime: meta?.updateTime,
        blockCount: Object.keys(allBlocks).length,
        workerBlockCount,
        hasMore: struct.has_more,
      },
      images,
      contentLength: markdown.length,
    };
  },
};
