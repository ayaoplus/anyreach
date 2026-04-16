// AnyReach adapter: chshopvip (泉林对症推拿 企业端营收汇总报表)
//
// 页面类型：
//   - revenue: 营收汇总表（/admin 企业端）
//   - home:    门店首页（自动导航到企业端）
//
// 方法分层：
//   导航层:  enterAdmin, openRevenueReport
//   交互层:  getShopList, queryShopRevenue, resetFilters, selectTime, selectShop, clickSearch
//   提取层:  extractRevenueData
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
//   摘要行:           .mr-pro-table-alert > .mr-col

import { sleep } from './_utils.mjs';

// =========================================================
// Browser-side JS snippets (run via proxy.eval)
// =========================================================

// 点击页面中第一个精确匹配文本的叶子节点
const clickLeafByText = (text) => `(() => {
  for (const el of document.querySelectorAll('*')) {
    if (el.innerText?.trim() === '${text}' && el.children.length === 0) {
      el.click(); return true;
    }
  }
  return false;
})()`;

// 点击按钮（文本去空格后匹配，兼容"查 询"/"重 置"）
const clickButton = (text) => `(() => {
  for (const btn of document.querySelectorAll('button')) {
    if (btn.innerText?.trim().replace(/\\s+/g, '') === '${text}') {
      btn.click(); return true;
    }
  }
  return false;
})()`;

// 点击时间 radio（今日/昨日/本周/本月/其他）
const clickTimeRadio = (label) => `(() => {
  for (const r of document.querySelectorAll('.mr-radio-button-label')) {
    if (r.innerText?.trim() === '${label}') { r.click(); return true; }
  }
  return false;
})()`;

// 打开店铺多选下拉（Ant Design 需要 mousedown）
const OPEN_SHOP_DROPDOWN = `(() => {
  const sel = document.querySelector('.mr-select-multiple .mr-select-selector');
  if (!sel) return false;
  sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  return true;
})()`;

// 读取下拉中当前已渲染的选项（虚拟滚动下只有可视区内的 DOM 存在）
// 返回 [{ id, name }]，id 是 option 的 DOM id（即店铺 ID，全局唯一）
const READ_VISIBLE_OPTIONS = `(() => {
  for (const dd of document.querySelectorAll('.mr-select-dropdown')) {
    if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
    return Array.from(dd.querySelectorAll('.mr-select-item-option')).map(opt => ({
      id: opt.id,
      name: opt.getAttribute('title') || opt.innerText?.trim(),
    }));
  }
  return [];
})()`;

// 滚动下拉的 rc-virtual-list-holder 到指定位置
const scrollDropdown = (top) => `(() => {
  for (const dd of document.querySelectorAll('.mr-select-dropdown')) {
    if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
    const holder = dd.querySelector('.rc-virtual-list-holder');
    if (holder) { holder.scrollTop = ${top}; return holder.scrollHeight; }
  }
  return 0;
})()`;

// 点击已展开下拉中指定 id 的选项（需要该选项已在可视区内）
// id 以数字开头不能用 CSS #id 选择器，遍历匹配
const clickDropdownById = (id) => `(() => {
  for (const dd of document.querySelectorAll('.mr-select-dropdown')) {
    if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
    for (const o of dd.querySelectorAll('.mr-select-item-option')) {
      if (o.id === '${id}') { o.click(); return o.getAttribute('title') || o.innerText?.trim(); }
    }
  }
  return null;
})()`;

// 检查指定 id 的选项是否已在 DOM 中
const isOptionVisible = (id) => `(() => {
  for (const dd of document.querySelectorAll('.mr-select-dropdown')) {
    if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
    for (const o of dd.querySelectorAll('.mr-select-item-option')) {
      if (o.id === '${id}') return true;
    }
  }
  return false;
})()`;

// 提取当前页面的营收报表数据（三张表 + 摘要）
const EXTRACT_REVENUE = `(() => {
  const proTables = document.querySelectorAll('.mr-pro-table');
  const sections = [];

  for (const pt of proTables) {
    const title = pt.querySelector('.header___B9TkP')?.innerText?.trim() || '';
    const table = pt.querySelector('table');
    if (!table) { sections.push({ title, headers: [], rows: [], footRows: [] }); continue; }

    const headers = Array.from(table.querySelectorAll('thead th'))
      .filter(th => !th.classList.contains('mr-table-selection-column'))
      .map(th => th.innerText?.trim()).filter(Boolean);

    const rows = [];
    table.querySelectorAll('tbody tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td'))
        .filter(td => !td.classList.contains('mr-table-selection-column'))
        .map(td => td.innerText?.trim());
      if (cells.length > 0 && !cells.every(c => !c) && !cells.some(c => c === '暂无数据'))
        rows.push(cells);
    });

    const footRows = [];
    table.querySelectorAll('tfoot tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(td => td.innerText?.trim());
      if (cells.length > 0) footRows.push(cells);
    });

    sections.push({ title, headers, rows, footRows });
  }

  // 摘要行：.mr-pro-table-alert 内的 .mr-col（跳过分隔符）
  const summary = {};
  const alertEl = document.querySelector('.mr-pro-table-alert');
  if (alertEl) {
    alertEl.querySelectorAll('.mr-col').forEach(col => {
      if (col.querySelector('.mr-divider')) return;
      const text = col.innerText?.trim();
      if (!text) return;
      const m = text.match(/^(.+?)：(.+)$/);
      if (m) summary[m[1]] = m[2];
    });
  }

  return { summary, sections };
})()`;

// 滚动内容区到顶部
const SCROLL_TOP = `(() => {
  const c = document.querySelector('.mr-pro-page-container');
  if (c) { c.scrollTop = 0; return true; }
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
        await this.enterAdmin(proxy, targetId);
        await this.openRevenueReport(proxy, targetId);
        return this._extractAllShopsRevenue(proxy, targetId, ctx);
      default:
        return { error: `unsupported page type: ${pageType}` };
    }
  },

  // =========================================================
  // 导航层：页面间跳转
  // =========================================================

  // 从 /home 进入企业端管理后台 /admin/home
  async enterAdmin(proxy, targetId) {
    await proxy.eval(targetId, clickLeafByText('去企业端'));
    await sleep(2000);
    await proxy.eval(targetId, clickLeafByText('进入企业'));
    await sleep(3000);

    const info = await proxy.info(targetId);
    if (!info.url?.includes('/admin')) {
      throw new Error(`enterAdmin failed, stuck at: ${info.url}`);
    }
  },

  // 在 /admin 内打开 报表 → 营收汇总表
  async openRevenueReport(proxy, targetId) {
    await proxy.eval(targetId, clickLeafByText('报表'));
    await sleep(2000);
    await proxy.eval(targetId, clickLeafByText('营收汇总表'));
    await sleep(2000);
  },

  // =========================================================
  // 交互层：表单操作
  // =========================================================

  // 重置筛选条件（时间回默认、店铺清空）
  async resetFilters(proxy, targetId) {
    await proxy.eval(targetId, clickButton('重置'));
    await sleep(1000);
  },

  // 选择时间范围（今日/昨日/本周/本月/其他）
  async selectTime(proxy, targetId, label = '昨日') {
    await proxy.eval(targetId, clickTimeRadio(label));
    await sleep(500);
  },

  // 获取所有店铺列表（打开下拉 → 滚动虚拟列表收集全部 → 关闭下拉）
  // 返回 [{ id, name, index }]
  async getShopList(proxy, targetId) {
    await proxy.eval(targetId, OPEN_SHOP_DROPDOWN);
    await sleep(1000);

    // rc-virtual-list 只渲染可视区内的 DOM，需要滚动收集全部选项
    const scrollHeight = await proxy.eval(targetId, scrollDropdown(0));
    const seen = new Map(); // id → name，去重

    // 先读当前位置
    const addVisible = async () => {
      const items = await proxy.eval(targetId, READ_VISIBLE_OPTIONS);
      for (const item of (items || [])) {
        if (item.id && !seen.has(item.id)) seen.set(item.id, item.name);
      }
    };

    await addVisible();

    if (scrollHeight > 0) {
      // 获取可视区高度，按步长滚动
      const clientHeight = await proxy.eval(targetId, `(() => {
        for (const dd of document.querySelectorAll('.mr-select-dropdown')) {
          if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
          return dd.querySelector('.rc-virtual-list-holder')?.clientHeight || 0;
        }
        return 0;
      })()`);

      if (clientHeight > 0) {
        for (let pos = clientHeight; pos <= scrollHeight; pos += clientHeight) {
          await proxy.eval(targetId, scrollDropdown(pos));
          await sleep(200);
          await addVisible();
        }
        // 确保滚到最底部
        await proxy.eval(targetId, scrollDropdown(scrollHeight));
        await sleep(200);
        await addVisible();
      }
    }

    // 关闭下拉
    await proxy.eval(targetId, `document.body.click()`);
    await sleep(500);

    // 转为数组，保持原始顺序（Map 保持插入顺序）
    return Array.from(seen.entries()).map(([id, name], i) => ({ id, name, index: i }));
  },

  // 选择指定店铺（打开下拉 → 滚动到目标 → 点击 → 关闭下拉）
  // shop: getShopList 返回的 { id, name } 对象
  async selectShop(proxy, targetId, shop) {
    await proxy.eval(targetId, OPEN_SHOP_DROPDOWN);
    await sleep(800);

    // 滚动虚拟列表直到目标选项渲染到 DOM
    let visible = await proxy.eval(targetId, isOptionVisible(shop.id));
    if (!visible) {
      const clientHeight = await proxy.eval(targetId, `(() => {
        for (const dd of document.querySelectorAll('.mr-select-dropdown')) {
          if (dd.classList.contains('mr-select-dropdown-hidden')) continue;
          return dd.querySelector('.rc-virtual-list-holder')?.clientHeight || 0;
        }
        return 0;
      })()`);
      const scrollHeight = await proxy.eval(targetId, scrollDropdown(0));

      for (let pos = clientHeight; pos <= scrollHeight && !visible; pos += clientHeight) {
        await proxy.eval(targetId, scrollDropdown(pos));
        await sleep(200);
        visible = await proxy.eval(targetId, isOptionVisible(shop.id));
      }
    }

    const name = await proxy.eval(targetId, clickDropdownById(shop.id));
    await sleep(300);
    await proxy.eval(targetId, `document.body.click()`);
    await sleep(300);
    return name;
  },

  // 点击查询并等待结果渲染
  async clickSearch(proxy, targetId) {
    await proxy.eval(targetId, clickButton('查询'));
    await sleep(2000);
    await proxy.eval(targetId, SCROLL_TOP);
    await sleep(500);
  },

  // =========================================================
  // 提取层：读取页面数据
  // =========================================================

  // 提取当前页面的营收报表数据（三张表 + 摘要）
  async extractRevenueData(proxy, targetId) {
    return proxy.eval(targetId, EXTRACT_REVENUE);
  },

  // 查询单个店铺的营收数据（重置 → 选时间 → 选店铺 → 查询 → 提取）
  // shop: getShopList 返回的 { id, name } 对象
  async queryShopRevenue(proxy, targetId, shop, timeLabel = '昨日') {
    await this.resetFilters(proxy, targetId);
    await this.selectTime(proxy, targetId, timeLabel);
    await this.selectShop(proxy, targetId, shop);
    await this.clickSearch(proxy, targetId);
    return this.extractRevenueData(proxy, targetId);
  },

  // =========================================================
  // 组合层：批量操作
  // =========================================================

  // 逐店铺查询营收并汇总
  async _extractAllShopsRevenue(proxy, targetId, ctx) {
    const timeLabel = ctx.timeLabel || '昨日';

    // 获取店铺列表
    await this.resetFilters(proxy, targetId);
    await this.selectTime(proxy, targetId, timeLabel);
    const shops = await this.getShopList(proxy, targetId);
    if (shops.length === 0) {
      return { error: 'no shop options found' };
    }

    // 逐店铺查询
    const results = [];
    for (const shop of shops) {
      const data = await this.queryShopRevenue(proxy, targetId, shop, timeLabel);
      results.push({ shopName: shop.name, shopId: shop.id, ...data });
    }

    return {
      timeLabel,
      shopCount: shops.length,
      shops: shops.map(s => s.name),
      results,
      format: 'json',
    };
  },
};
