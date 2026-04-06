// AnyReach 飞书适配器
// 通过 window.DATA.clientVars.data 直接读取文档内存数据
// 完全绕过虚拟化渲染，100% 提取文档全文
//
// 飞书在浏览器中通过 window.DATA 暴露文档数据：
//   - clientVars.data.block_map: 所有文档块的映射表
//   - clientVars.data.block_sequence: 文档块的渲染顺序
//   - 每个 block 包含 type（段落类型）和 text（文本内容）

// 等待飞书文档数据加载完成
const WAIT_DATA_JS = `new Promise((resolve) => {
  let tries = 0;
  const check = () => {
    const d = window.DATA?.clientVars?.data;
    if (d?.block_map && d?.block_sequence?.length > 0) {
      return resolve({ ready: true, blocks: d.block_sequence.length });
    }
    if (++tries > 30) return resolve({ ready: false, timeout: true });
    setTimeout(check, 500);
  };
  check();
})`;

// 从 window.DATA 提取完整文档内容并转为 Markdown
const EXTRACT_FROM_DATA_JS = `(() => {
  const d = window.DATA?.clientVars?.data;
  if (!d?.block_map || !d?.block_sequence) return null;

  const seq = d.block_sequence;
  const map = d.block_map;
  const lines = [];
  let orderedCounter = 1;
  let lastType = '';

  for (const id of seq) {
    const b = map[id];
    if (!b?.data) continue;
    const type = b.data.type;
    const raw = b.data.text?.initialAttributedTexts?.text?.['0'] || '';
    const text = raw.trim();
    if (!text) continue;

    // 有序列表计数器重置
    if (type !== 'ordered' && lastType === 'ordered') orderedCounter = 1;

    switch (type) {
      case 'page':
        lines.push('# ' + text);
        break;
      case 'heading1':
        lines.push('\\n# ' + text);
        break;
      case 'heading2':
        lines.push('\\n## ' + text);
        break;
      case 'heading3':
        lines.push('\\n### ' + text);
        break;
      case 'heading4':
        lines.push('\\n#### ' + text);
        break;
      case 'heading5':
        lines.push('\\n##### ' + text);
        break;
      case 'ordered':
        lines.push(orderedCounter + '. ' + text);
        orderedCounter++;
        break;
      case 'bullet':
        lines.push('- ' + text);
        break;
      case 'todo':
        lines.push('- [ ] ' + text);
        break;
      case 'quote_container':
      case 'callout':
        lines.push('> ' + text);
        break;
      case 'code':
        lines.push('${'`'}${'`'}${'`'}\\n' + text + '\\n${'`'}${'`'}${'`'}');
        break;
      case 'divider':
        lines.push('---');
        break;
      default:
        // text, paragraph 等普通文本块
        lines.push(text);
    }
    lastType = type;
  }

  return lines.join('\\n');
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
  };
})()`;

export default {
  name: 'feishu',
  domains: ['feishu.cn', 'larksuite.com'],
  description: '飞书知识库/云文档内容提取（通过 window.DATA 内存数据）',

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

    // 从内存数据直接提取
    const content = await proxy.eval(targetId, EXTRACT_FROM_DATA_JS);
    const meta = await proxy.eval(targetId, EXTRACT_META_JS);

    return {
      title: meta?.title || '',
      content: content || '',
      format: 'markdown',
      meta: {
        author: meta?.author,
        createTime: meta?.createTime,
        updateTime: meta?.updateTime,
        blockCount: meta?.blockCount,
      },
      contentLength: content?.length || 0,
    };
  },
};
