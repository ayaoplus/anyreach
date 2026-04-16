// AnyReach adapter: chshopvip (泉林对症推拿 企业端营收汇总报表)
//
// 页面类型：
//   - revenue: 营收汇总表（/admin 企业端）
//
// 流程：
//   1. 从 /home 进入企业端 → /admin/home
//   2. 点击左侧导航"报表" → 自动展开"营收汇总表"
//   3. 选择"昨日"，逐个选择店铺查询，提取三张表格数据
//   4. 重置条件后查询下一个店铺，直到全部完成
//
// DOM 关键选择器：
//   滚动容器:         .mr-pro-page-container
//   时间按钮:         .mr-radio-button-label (text match)
//   店铺下拉:         .mr-select-multiple .mr-select-selector (mousedown to open)
//   下拉选项:         .mr-select-dropdown:not(.mr-select-dropdown-hidden) .mr-select-item-option
//   查询按钮:         button (text match "查 询")
//   重置按钮:         button (text match "重 置")
//   营业收入表:       第1个 .mr-pro-table table
//   营业支出表:       第2个 .mr-pro-table table
//   应上交现金表:     第3个 .mr-pro-table table
//   摘要行:           div containing "总营业收入："

import { sleep } from './_utils.mjs';

// =========================================================
// JS extraction snippets (run inside browser via proxy.eval)
// =========================================================

// --- 获取所有店铺选项（需先 mousedown 打开下拉） ---
const GET_SHOP_OPTIONS_JS = `(() => {
  const dropdowns = document.querySelectorAll('.mr-select-dropdown');
  for (const dd of dropdowns) {
    if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
    const options = dd.querySelectorAll('.mr-select-item-option');
    return Array.from(options).map((opt, idx) => ({
      name: opt.innerText?.trim(),
      title: opt.getAttribute('title') || opt.innerText?.trim(),
      index: idx,
    }));
  }
  return [];
})()`;

// --- 选择指定索引的店铺（下拉已打开状态下） ---
const selectShopByIndex = (idx) => `(() => {
  const dropdowns = document.querySelectorAll('.mr-select-dropdown');
  for (const dd of dropdowns) {
    if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
    const options = dd.querySelectorAll('.mr-select-item-option');
    const target = options[${idx}];
    if (target) { target.click(); return target.innerText?.trim(); }
  }
  return null;
})()`;

// --- 点击指定文本的按钮 ---
const clickButtonByText = (text) => `(() => {
  const btns = document.querySelectorAll('button');
  for (const btn of btns) {
    const t = btn.innerText?.trim().replace(/\\s+/g, '');
    if (t === '${text}') { btn.click(); return true; }
  }
  return false;
})()`;

// --- 点击时间选项（昨日/今日/本周/本月） ---
const clickTimeOption = (label) => `(() => {
  const radios = document.querySelectorAll('.mr-radio-button-label');
  for (const r of radios) {
    if (r.innerText?.trim() === '${label}') { r.click(); return true; }
  }
  return false;
})()`;

// --- 提取当前页面全部报表数据 ---
const EXTRACT_REVENUE_DATA_JS = `(() => {
  // 找到所有 mr-pro-table 容器，按出现顺序为：营业收入、营业支出、应上交现金
  const proTables = document.querySelectorAll('.mr-pro-table');
  const sections = [];

  for (const pt of proTables) {
    const titleEl = pt.querySelector('.header___B9TkP');
    const title = titleEl?.innerText?.trim() || '';

    const table = pt.querySelector('table');
    if (!table) {
      sections.push({ title, headers: [], rows: [], footRows: [] });
      continue;
    }

    const headers = Array.from(table.querySelectorAll('thead th'))
      .filter(th => !th.classList.contains('mr-table-selection-column'))
      .map(th => th.innerText?.trim())
      .filter(Boolean);

    const rows = [];
    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td'))
        // 跳过 selection-column（复选框列）
        .filter(td => !td.classList.contains('mr-table-selection-column'))
        .map(td => td.innerText?.trim());
      // 过滤空行和"暂无数据"行
      if (cells.length > 0 && !cells.every(c => !c) && !cells.some(c => c === '暂无数据')) {
        rows.push(cells);
      }
    });

    const footRows = [];
    table.querySelectorAll('tfoot tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText?.trim());
      if (cells.length > 0) footRows.push(cells);
    });

    sections.push({ title, headers, rows, footRows });
  }

  // 营业收入摘要行（总营业收入：xxx | 自办POS机：xxx ...）
  // DOM: .mr-pro-table-alert > ... > .mr-row > .mr-col（包含分隔符 .mr-divider）
  const summary = {};
  const alertEl = document.querySelector('.mr-pro-table-alert');
  if (alertEl) {
    const cols = alertEl.querySelectorAll('.mr-col');
    cols.forEach(col => {
      // 跳过分隔符列
      if (col.querySelector('.mr-divider')) return;
      const text = col.innerText?.trim();
      if (!text) return;
      const match = text.match(/^(.+?)：(.+)$/);
      if (match) summary[match[1]] = match[2];
    });
  }

  return { summary, sections };
})()`;

// --- 打开店铺下拉 ---
const OPEN_SHOP_DROPDOWN_JS = `(() => {
  const sel = document.querySelector('.mr-select-multiple .mr-select-selector');
  if (sel) {
    sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return true;
  }
  return false;
})()`;

// --- 关闭下拉 ---
const CLOSE_DROPDOWN_JS = `document.body.click()`;

// --- 滚动到顶部（使用内部滚动容器） ---
const SCROLL_TOP_JS = `(() => {
  const container = document.querySelector('.mr-pro-page-container');
  if (container) { container.scrollTop = 0; return true; }
  window.scrollTo(0, 0);
  return false;
})()`;

// =========================================================
// Adapter export
// =========================================================
export default {
  name: 'chshopvip',
  domains: ['qltn.chshopvip.com'],
  description: '泉林对症推拿：企业端营收汇总表，逐店铺查询昨日营收数据',

  detect(url) {
    if (url.includes('/admin')) return 'revenue';
    return 'home';
  },

  async extract(proxy, targetId, ctx) {
    const { pageType } = ctx;

    switch (pageType) {
      case 'revenue':
        return this._extractAllShopsRevenue(proxy, targetId, ctx);
      case 'home':
        // 从首页进入企业端再提取
        return this._navigateToAdminAndExtract(proxy, targetId, ctx);
      default:
        return { error: `unsupported page type: ${pageType}` };
    }
  },

  // --- 从首页导航到企业端，再提取营收 ---
  async _navigateToAdminAndExtract(proxy, targetId, ctx) {
    // 1. 点击"去企业端"
    await proxy.eval(targetId, `(() => {
      const els = document.querySelectorAll('*');
      for (const el of els) {
        if (el.innerText?.trim() === '去企业端' && el.children.length === 0) {
          el.click(); return true;
        }
      }
      return false;
    })()`);
    await sleep(2000);

    // 2. 点击"进入企业"
    await proxy.eval(targetId, `(() => {
      const els = document.querySelectorAll('*');
      for (const el of els) {
        if (el.innerText?.trim() === '进入企业' && el.children.length === 0) {
          el.click(); return true;
        }
      }
      return false;
    })()`);
    await sleep(3000);

    // 3. 确认已进入 admin 页面
    const info = await proxy.info(targetId);
    if (!info.url?.includes('/admin')) {
      return { error: 'failed to navigate to admin page', currentUrl: info.url };
    }

    // 4. 点击"报表"导航
    await proxy.eval(targetId, `(() => {
      const els = document.querySelectorAll('*');
      for (const el of els) {
        if (el.innerText?.trim() === '报表' && el.children.length === 0) {
          el.click(); return true;
        }
      }
      return false;
    })()`);
    await sleep(2000);

    // 5. 点击"营收汇总表"（如果没有自动选中）
    await proxy.eval(targetId, `(() => {
      const els = document.querySelectorAll('*');
      for (const el of els) {
        if (el.innerText?.trim() === '营收汇总表' && el.children.length === 0) {
          el.click(); return true;
        }
      }
      return false;
    })()`);
    await sleep(2000);

    return this._extractAllShopsRevenue(proxy, targetId, ctx);
  },

  // --- 逐店铺查询昨日营收并汇总 ---
  async _extractAllShopsRevenue(proxy, targetId, ctx) {
    const timeLabel = ctx.timeLabel || '昨日';

    // 1. 先重置一下确保干净状态
    await proxy.eval(targetId, clickButtonByText('重置'));
    await sleep(1000);

    // 2. 选择时间
    await proxy.eval(targetId, clickTimeOption(timeLabel));
    await sleep(500);

    // 3. 打开店铺下拉，获取所有选项
    await proxy.eval(targetId, OPEN_SHOP_DROPDOWN_JS);
    await sleep(1000);
    const shops = await proxy.eval(targetId, GET_SHOP_OPTIONS_JS);
    // 关闭下拉
    await proxy.eval(targetId, CLOSE_DROPDOWN_JS);
    await sleep(500);

    if (!shops || shops.length === 0) {
      return { error: 'no shop options found' };
    }

    // 4. 逐店铺查询
    const allResults = [];
    for (let i = 0; i < shops.length; i++) {
      const shop = shops[i];

      // 重置条件
      await proxy.eval(targetId, clickButtonByText('重置'));
      await sleep(1000);

      // 选择"昨日"
      await proxy.eval(targetId, clickTimeOption(timeLabel));
      await sleep(500);

      // 打开下拉并选择当前店铺
      await proxy.eval(targetId, OPEN_SHOP_DROPDOWN_JS);
      await sleep(800);
      await proxy.eval(targetId, selectShopByIndex(i));
      await sleep(300);
      // 关闭下拉
      await proxy.eval(targetId, CLOSE_DROPDOWN_JS);
      await sleep(300);

      // 点击查询
      await proxy.eval(targetId, clickButtonByText('查询'));
      await sleep(2000);

      // 滚动到顶部
      await proxy.eval(targetId, SCROLL_TOP_JS);
      await sleep(500);

      // 提取数据
      const data = await proxy.eval(targetId, EXTRACT_REVENUE_DATA_JS);
      allResults.push({
        shopName: shop.name,
        shopIndex: i,
        ...data,
      });
    }

    return {
      timeLabel,
      shopCount: shops.length,
      shops: shops.map(s => s.name),
      results: allResults,
      format: 'json',
    };
  },
};
