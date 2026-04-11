// AnyReach 蝉妈妈适配器 - chanmama.com
// 支持页面类型：
//   - bloggerRank: 达人库（筛选 + 列表）
//   - bloggerDetail: 达人详情页（/bloggerRank/ID.html）
//
// 核心功能模块：
//   - applyFilters: 组合筛选条件并搜索
//   - applySavedCondition: 加载已保存的常用条件
//   - extractResults: 提取达人列表数据（含 detailUrl）
//   - extractBio: 提取达人简介（详情页，自动展开长文本）
//   - nextPage / gotoPage: 翻页
//
// DOM 结构要点 (Vue + Element UI)：
//   - 筛选区: .search-menu > .condition-box.pl20 > .condition-item (5 rows)
//     row0: 带货分类 — span.item (click toggle, .active = selected)
//     row1: 达人分类 — .category-item (click toggle, .able = selected)
//     row2: 达人信息 — 包含达人画像(el-radio)/粉丝画像(el-radio)/粉丝数(select)/checkboxes
//     row3: 带货信息 — 带货等级(multi-select)/带货方式(select)/商品价格(select)/GMV
//     row4: 其它 — 直播场均销售额/视频平均销售额/checkboxes
//   - 搜索按钮: .search-icon (img inside el-button)
//   - 已保存条件: .save-condition-item (inside .common-save-conditions)
//   - 结果表格: .search-result table (el-table)
//   - 分页: .el-pagination
//
// 带货分类的二级分类需要先点一级（如"日用百货"）触发 popover，再在弹出面板中选二级

import { sleep } from './_utils.mjs';

// --- 核心交互 helper ---
// 蝉妈妈使用 Vue + Element UI，JS .click() 无法触发 Vue 事件绑定，
// 必须通过 CDP Input.dispatchMouseEvent（即 proxy.clickAt）进行真实鼠标点击。
// 策略：eval 设置临时 id → clickAt 用 #id 选择器点击。

/** 设置临时 id 到匹配的元素上，返回是否找到 */
const markTarget = (selector, text, extra = '') => `
(() => {
  document.getElementById('__chanmama_tmp')?.removeAttribute('id');
  const els = document.querySelectorAll('${selector}');
  for (const el of els) {
    if (el.textContent.trim() === '${text}' && el.offsetHeight > 0) {
      ${extra}
      el.id = '__chanmama_tmp'; return true;
    }
  }
  return false;
})()`;

const TMP_SEL = '#__chanmama_tmp';

/** 等待页面加载完成（筛选区域 DOM 渲染完毕） */
async function waitForReady(proxy, targetId, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ready = await proxy.eval(targetId, `
      (() => {
        const box = document.querySelector('.condition-box.pl20');
        const spans = box?.querySelectorAll('.flex-flow-row-wrap span');
        return !!(spans && spans.length > 5);
      })()
    `);
    if (ready) return true;
    await sleep(500);
  }
  return false;
}

// --- JS: 提取达人列表 ---
const EXTRACT_RESULTS_JS = `(() => {
  const rows = document.querySelectorAll('.search-result tbody tr');
  return Array.from(rows).map(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 8) return null;

    // 达人信息 cell — DOM 结构:
    //   td > div.flex > a.img-box-war(头像+链接) + div(名字区) + div.c999(抖音号)
    const infoCell = cells[0];
    const nameDiv = infoCell.querySelector('.text-align-left.c333');
    const nameLink = nameDiv?.querySelector('a');
    const name = nameLink?.textContent?.trim() || nameDiv?.textContent?.trim() || '';
    const profileLink = infoCell.querySelector('a.img-box-war')?.href || nameLink?.href || '';
    const douyinId = infoCell.querySelector('.ellipsis-1.text-align-left.c999')?.textContent?.trim() || '';
    const avatar = infoCell.querySelector('.img-box img')?.src || '';
    const hasLevel = !!infoCell.querySelector('img[alt="带货等级"]');

    // 动态读取表头，按表头名映射字段
    const headers = document.querySelectorAll('.search-result thead th');
    const headerMap = {};
    headers.forEach((th, i) => {
      headerMap[th.textContent.replace(/[↑↓▲▼♦◆]/g, '').trim()] = i;
    });
    const col = (name) => cells[headerMap[name]]?.textContent?.trim() || '';

    return {
      name,
      douyinId,
      hasLevel,
      avatar,
      profileLink,
      followers: col('粉丝数'),
      liveSessions: col('直播场次'),
      avgViews: col('平均场观'),
      avgStayTime: col('平均停留时长'),
      avgOnline: col('平均在线人数'),
      liveSales: col('直播销售额'),
      liveHourlyOutput: col('直播小时产出'),
      avgSessionSales: col('场均销售额'),
      // 以下字段在其他列配置中可能出现
      newFollowers: col('新增粉丝'),
      sales: col('销售额'),
      videoSales: col('视频销售额'),
      likeRatio: col('平均赞粉比'),
    };
  }).filter(Boolean);
})()`;

// --- JS: 获取当前页码和总页数 ---
const GET_PAGINATION_JS = `(() => {
  const pager = document.querySelector('.el-pagination');
  if (!pager) return { current: 1, total: 1 };
  const active = pager.querySelector('.el-pager .active, .el-pager li.active');
  const last = pager.querySelector('.el-pager li:last-child');
  return {
    current: parseInt(active?.textContent?.trim() || '1'),
    total: parseInt(last?.textContent?.trim() || '1'),
  };
})()`;

// --- JS: 获取当前筛选状态 ---
const GET_FILTER_STATE_JS = `(() => {
  const rows = document.querySelectorAll('.condition-box.pl20 > .condition-item');
  const state = {};

  // row0: 带货分类
  const activeCategory = rows[0]?.querySelector('.flex-flow-row-wrap span.item.active');
  state.category = activeCategory?.textContent?.trim() || '全部';

  // row2: 达人画像 — 当前选中的性别 radio
  const sec0 = rows[2]?.children[1]?.children[0];
  const checkedRadio0 = sec0?.querySelector('.el-radio.is-checked .el-radio__label');
  state.bloggerGender = checkedRadio0?.textContent?.trim() || '不限';

  // row2: 粉丝画像 — 性别 radio
  const sec1 = rows[2]?.children[1]?.children[1];
  const checkedRadio1 = sec1?.querySelector('.el-radio.is-checked .el-radio__label');
  state.fanGender = checkedRadio1?.textContent?.trim() || '全部';

  // row2: checkboxes
  const checkboxes = [];
  rows[2]?.querySelectorAll('.el-checkbox.is-checked .el-checkbox__label').forEach(l => {
    checkboxes.push(l.textContent.trim());
  });
  state.infoCheckboxes = checkboxes;

  // row3: 带货等级/带货方式 (select dropdowns - read display value)
  // row4: other checkboxes
  const otherCheckboxes = [];
  rows[4]?.querySelectorAll('.el-checkbox.is-checked .el-checkbox__label').forEach(l => {
    otherCheckboxes.push(l.textContent.trim());
  });
  state.otherCheckboxes = otherCheckboxes;

  // saved conditions
  const saved = [];
  document.querySelectorAll('.save-condition-item').forEach(item => {
    const name = item.textContent?.replace('重命名', '').replace('删除', '').trim();
    if (name) saved.push(name);
  });
  state.savedConditions = saved;

  return state;
})()`;

export default {
  name: 'chanmama',
  domains: ['chanmama.com'],
  description: '蝉妈妈 — 达人库筛选、达人列表提取、达人详情页简介提取',

  detect(url) {
    // 详情页: /bloggerRank/ID.html（ID 为 base64 字符串）
    // 必须先匹配详情页，否则会被 bloggerRank 列表页规则截获
    if (/\/bloggerRank\/[A-Za-z0-9_-]+\.html/i.test(url)) return 'bloggerDetail';
    if (/bloggerRank/i.test(url)) return 'bloggerRank';
    return 'default';
  },

  /**
   * 主入口 — 根据 ctx.action 分发
   * bloggerRank (列表页) 支持的 action:
   *   - 'applyFilters': 设置筛选条件并搜索 (ctx.filters)
   *   - 'applySavedCondition': 加载保存的条件 (ctx.conditionName)
   *   - 'extractResults': 提取当前页达人列表（含 detailUrl）
   *   - 'extractAll': 提取所有页（带翻页）
   *   - 'getFilterState': 获取当前筛选状态
   *   - 'nextPage': 翻到下一页
   *   - 'gotoPage': 跳转指定页 (ctx.page)
   *   - 'search': 点击搜索按钮
   * bloggerDetail (详情页) 支持的 action:
   *   - 'extractBio': 提取达人简介（自动展开长文本）
   */
  async extract(proxy, targetId, ctx) {
    const action = ctx.action || 'extractResults';
    const pageType = ctx.pageType || 'bloggerRank';

    // 详情页 action
    if (pageType === 'bloggerDetail') {
      switch (action) {
        case 'extractBio':
          return await this._extractBio(proxy, targetId);
        default:
          // 详情页默认提取简介
          return await this._extractBio(proxy, targetId);
      }
    }

    // 列表页 action
    switch (action) {
      case 'applyFilters':
        return await this._applyFilters(proxy, targetId, ctx.filters || {});
      case 'applySavedCondition':
        return await this._applySavedCondition(proxy, targetId, ctx.conditionName);
      case 'extractResults':
        return await this._extractResults(proxy, targetId);
      case 'extractAll':
        return await this._extractAll(proxy, targetId, ctx.maxPages);
      case 'getFilterState':
        return await this._getFilterState(proxy, targetId);
      case 'nextPage':
        return await this._nextPage(proxy, targetId);
      case 'gotoPage':
        return await this._gotoPage(proxy, targetId, ctx.page);
      case 'search':
        return await this._clickSearch(proxy, targetId);
      default:
        return { error: `unknown action: ${action}` };
    }
  },

  // =====================================================================
  // 筛选条件设置
  // =====================================================================

  /**
   * 设置筛选条件并点击搜索
   * 所有交互使用 CDP 真实鼠标点击（clickAt），因为 Vue 事件绑定不响应 JS .click()
   * @param {Object} filters - 筛选条件:
   *   - category {string} 带货分类一级（如 "日用百货"）
   *   - subCategory {string} 带货分类二级（如 "个人护理"）
   *   - bloggerGender {string} 达人画像性别："不限"|"男"|"女"
   *   - fanGender {string} 粉丝画像性别："全部"|"男性居多"|"女性居多"
   *   - checkDaren {boolean} 勾选达人号
   *   - levels {string[]} 带货等级 ["LV1","LV2","LV3","LV4"]
   *   - sellMode {string} 带货方式："直播带货为主"|"视频带货为主"|"图文带货为主"
   *   - liveHourlyOutput {string} 直播场均小时产出："1000-1万"|"<1000"|"1万-10万"|...
   */
  async _applyFilters(proxy, targetId, filters) {
    const results = [];

    // 0. 等待页面加载完成 + 点击搜索框激活页面交互
    //    后台 tab 的首次 CDP 鼠标事件不触发 Vue 响应，需要先激活
    await waitForReady(proxy, targetId);
    await proxy.eval(targetId, `
      (() => {
        document.getElementById('__chanmama_tmp')?.removeAttribute('id');
        const input = document.querySelector('input[placeholder*="达人"]');
        if (input) { input.id = '__chanmama_tmp'; return true; }
        return false;
      })()
    `);
    await proxy.clickAt(targetId, TMP_SEL);
    await sleep(300);

    // 1. 带货分类 — 一级 + 可选二级
    //    注意：每个分类是 <span><span class="el-tooltip item">文字</span></span>
    //    必须点击外层 span（wrapper.children），内层 el-tooltip 不触发 Vue 事件
    if (filters.category) {
      // 先点"全部"重置，再点目标分类（否则 popover 不会弹出）
      if (filters.subCategory) {
        const resetFound = await proxy.eval(targetId, `
          (() => {
            document.getElementById('__chanmama_tmp')?.removeAttribute('id');
            const wrapper = document.querySelector('.condition-box.pl20 .condition-item:first-child .flex-flow-row-wrap');
            if (!wrapper) return false;
            for (const s of wrapper.children) {
              if (s.textContent.trim() === '全部') { s.id = '__chanmama_tmp'; return true; }
            }
            return false;
          })()
        `);
        if (resetFound) await proxy.clickAt(targetId, TMP_SEL);
        await sleep(300);
      }

      const found = await proxy.eval(targetId, `
        (() => {
          document.getElementById('__chanmama_tmp')?.removeAttribute('id');
          const wrapper = document.querySelector('.condition-box.pl20 .condition-item:first-child .flex-flow-row-wrap');
          if (!wrapper) return false;
          for (const s of wrapper.children) {
            if (s.textContent.trim() === '${filters.category}') { s.id = '__chanmama_tmp'; return true; }
          }
          return false;
        })()
      `);
      if (found) {
        const r = await proxy.clickAt(targetId, TMP_SEL);
        results.push({ step: 'category', value: filters.category, ok: r.clicked });
      } else {
        results.push({ step: 'category', value: filters.category, ok: false });
      }

      // 二级分类 — 一级点击后 popover 自动弹出
      if (filters.subCategory) {
        await sleep(300);
        const subFound = await proxy.eval(targetId, `
          (() => {
            document.getElementById('__chanmama_tmp')?.removeAttribute('id');
            const els = document.querySelectorAll('*');
            for (const el of els) {
              if (el.textContent.trim() === '${filters.subCategory}' &&
                  el.offsetHeight > 0 && el.children.length <= 1) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  el.id = '__chanmama_tmp'; return true;
                }
              }
            }
            return false;
          })()
        `);
        if (subFound) {
          const r = await proxy.clickAt(targetId, TMP_SEL);
          results.push({ step: 'subCategory', value: filters.subCategory, ok: r.clicked });
        } else {
          results.push({ step: 'subCategory', value: filters.subCategory, ok: false });
        }
        await sleep(500);
        // 点击空白关闭三级分类弹窗
        await proxy.eval(targetId, `document.querySelector('.condition-box.pl20 .lab')?.click()`);
        await sleep(300);
      }
    }

    // 2. 达人画像 — 打开面板，选 radio，点确定
    if (filters.bloggerGender) {
      const panelFound = await proxy.eval(targetId, markTarget('.input-box', '达人画像'));
      if (panelFound) await proxy.clickAt(targetId, TMP_SEL);
      await sleep(500);

      const ok = await this._clickPopoverItem(proxy, targetId, '.el-popover', filters.bloggerGender);
      results.push({ step: 'bloggerGender', value: filters.bloggerGender, ok });
      await sleep(300);
      await this._clickPopoverConfirm(proxy, targetId);
      await sleep(300);
    }

    // 3. 粉丝画像 — 打开面板，选 radio，点确定
    if (filters.fanGender) {
      const panelFound = await proxy.eval(targetId, markTarget('.input-box', '粉丝画像'));
      if (panelFound) await proxy.clickAt(targetId, TMP_SEL);
      await sleep(500);

      const ok = await this._clickPopoverItem(proxy, targetId, '.el-popover', filters.fanGender);
      results.push({ step: 'fanGender', value: filters.fanGender, ok });
      await sleep(300);
      await this._clickPopoverConfirm(proxy, targetId);
      await sleep(300);
    }

    // 4. 达人号 checkbox
    if (filters.checkDaren) {
      const found = await proxy.eval(targetId, `
        (() => {
          document.getElementById('__chanmama_tmp')?.removeAttribute('id');
          const cbs = document.querySelectorAll('.condition-box.pl20 .el-checkbox');
          for (const cb of cbs) {
            if (cb.querySelector('.el-checkbox__label')?.textContent?.trim() === '达人号') {
              if (!cb.classList.contains('is-checked')) { cb.id = '__chanmama_tmp'; return true; }
              return 'already_checked';
            }
          }
          return false;
        })()
      `);
      if (found === true) {
        const r = await proxy.clickAt(targetId, TMP_SEL);
        results.push({ step: 'checkDaren', ok: r.clicked });
      } else {
        results.push({ step: 'checkDaren', ok: found === 'already_checked' });
      }
      await sleep(300);
    }

    // 5. 带货等级 — 打开面板，逐个点选
    if (filters.levels && filters.levels.length > 0) {
      const panelFound = await proxy.eval(targetId, markTarget('.input-box', '带货等级'));
      if (panelFound) await proxy.clickAt(targetId, TMP_SEL);
      await sleep(500);

      for (const level of filters.levels) {
        const ok = await this._clickPopoverItem(proxy, targetId, '.common-search-multiple-select-popover', level);
        results.push({ step: 'level', value: level, ok });
        await sleep(200);
      }
      // 关闭 popover
      await proxy.eval(targetId, `document.querySelector('.condition-box.pl20 .lab')?.click()`);
      await sleep(300);
    }

    // 6. 带货方式 — 打开面板，选择选项
    if (filters.sellMode) {
      const panelFound = await proxy.eval(targetId, markTarget('.input-box', '带货方式'));
      if (panelFound) await proxy.clickAt(targetId, TMP_SEL);
      await sleep(500);

      const ok = await this._clickPopoverItem(proxy, targetId, '.common-search-select-popover', filters.sellMode);
      results.push({ step: 'sellMode', value: filters.sellMode, ok });
      await sleep(300);
    }

    // 7. 直播场均小时产出 — 打开"直播表现"面板，点下拉框，选值，确定
    if (filters.liveHourlyOutput) {
      // 打开直播表现面板
      const panelFound = await proxy.eval(targetId, markTarget('.input-box', '直播表现'));
      if (panelFound) await proxy.clickAt(targetId, TMP_SEL);
      await sleep(800);

      // 点击第2个 custom-select-box（小时产出的下拉框）
      const selFound = await proxy.eval(targetId, `
        (() => {
          document.getElementById('__chanmama_tmp')?.removeAttribute('id');
          const pops = document.querySelectorAll('.el-popover');
          for (const pop of pops) {
            if (pop.style.display === 'none' || !pop.offsetHeight) continue;
            if (!pop.textContent.includes('小时产出')) continue;
            const selects = pop.querySelectorAll('.custom-select-box');
            if (selects[1]) { selects[1].id = '__chanmama_tmp'; return true; }
          }
          return false;
        })()
      `);
      if (selFound) await proxy.clickAt(targetId, TMP_SEL);
      await sleep(500);

      // 在展开的下拉中选择目标值
      const itemFound = await proxy.eval(targetId, `
        (() => {
          document.getElementById('__chanmama_tmp')?.removeAttribute('id');
          const all = document.querySelectorAll('div.item, span');
          for (const el of all) {
            if (el.textContent.trim() === '${filters.liveHourlyOutput}' && el.offsetHeight > 0 && el.children.length === 0) {
              el.id = '__chanmama_tmp'; return true;
            }
          }
          return false;
        })()
      `);
      if (itemFound) {
        const r = await proxy.clickAt(targetId, TMP_SEL);
        results.push({ step: 'liveHourlyOutput', value: filters.liveHourlyOutput, ok: r.clicked });
      } else {
        results.push({ step: 'liveHourlyOutput', value: filters.liveHourlyOutput, ok: false });
      }
      await sleep(300);

      // 点击面板的"确定"按钮
      await this._clickPopoverConfirm(proxy, targetId);
      await sleep(300);
    }

    // 8. 点击搜索
    await this._clickSearch(proxy, targetId);
    await sleep(2000);

    return { action: 'applyFilters', steps: results };
  },

  // =====================================================================
  // 加载保存的条件
  // =====================================================================

  /**
   * 点击已保存的常用条件（如"阿周"）
   * 注意：DOM 中 .save-condition-item 可能存在多个同名节点（展示 + 交互），
   * 需要定位到可见且可交互的那个，并点击其内部的名称文本元素（而非容器）。
   * Vue 事件绑定在特定子元素上，点击容器不一定触发。
   */
  async _applySavedCondition(proxy, targetId, name) {
    if (!name) return { error: 'conditionName is required' };

    // 先激活页面交互（后台 tab 首次 CDP 鼠标事件不触发 Vue 响应）
    await proxy.eval(targetId, `
      (() => {
        document.getElementById('__chanmama_tmp')?.removeAttribute('id');
        const input = document.querySelector('input[placeholder*="达人"]');
        if (input) { input.id = '__chanmama_tmp'; return true; }
        return false;
      })()
    `);
    await proxy.clickAt(targetId, TMP_SEL);
    await sleep(300);

    // 查找匹配的保存条件：优先可见 + 可交互节点，点击名称文本而非容器
    const found = await proxy.eval(targetId, `
      (() => {
        document.getElementById('__chanmama_tmp')?.removeAttribute('id');
        const container = document.querySelector('.common-save-conditions');
        if (!container) return 'no_container';
        const items = container.querySelectorAll('.save-condition-item');
        for (const item of items) {
          if (!item.offsetHeight || item.offsetHeight <= 0) continue;
          const text = item.textContent.replace('重命名', '').replace('删除', '').trim();
          if (text !== '${name}') continue;
          // 优先点击内部的名称 span（跳过"重命名"/"删除"按钮），
          // 找不到则点击 item 自身
          const spans = item.querySelectorAll('span, div, a, p');
          let target = null;
          for (const s of spans) {
            const st = s.textContent?.trim();
            if (st === '${name}' && s.offsetHeight > 0 && s.children.length <= 1) {
              target = s; break;
            }
          }
          (target || item).id = '__chanmama_tmp';
          return true;
        }
        return false;
      })()
    `);

    if (found === 'no_container') return { error: 'saved conditions panel not found (.common-save-conditions)' };
    if (!found) return { error: `saved condition "${name}" not found` };

    await proxy.clickAt(targetId, TMP_SEL);
    await sleep(2000);

    // 验证：点击后筛选条件应该发生变化（URL hash 或 DOM 状态）
    const verified = await proxy.eval(targetId, `
      (() => {
        // 检查搜索结果区是否有 loading 或已有数据
        const loading = document.querySelector('.el-loading-mask');
        const rows = document.querySelectorAll('.search-result tbody tr');
        return { loading: !!loading, resultCount: rows.length };
      })()
    `);

    return { action: 'applySavedCondition', name, ok: true, verified };
  },

  // =====================================================================
  // 提取结果
  // =====================================================================

  /** 提取当前页达人列表 */
  async _extractResults(proxy, targetId) {
    await proxy.waitFor(targetId, '.search-result tbody tr', 10000).catch(() => {});
    const data = await proxy.eval(targetId, EXTRACT_RESULTS_JS);
    const pagination = await proxy.eval(targetId, GET_PAGINATION_JS);
    return {
      action: 'extractResults',
      bloggers: data || [],
      pagination: pagination || { current: 1, total: 1 },
    };
  },

  /** 提取多页达人列表 */
  async _extractAll(proxy, targetId, maxPages = 5) {
    const allBloggers = [];
    let page = 1;

    while (page <= maxPages) {
      const result = await this._extractResults(proxy, targetId);
      allBloggers.push(...(result.bloggers || []));

      const { current, total } = result.pagination;
      if (current >= total || page >= maxPages) break;

      await this._nextPage(proxy, targetId);
      await sleep(2000);
      page++;
    }

    return { action: 'extractAll', totalBloggers: allBloggers.length, bloggers: allBloggers };
  },

  // =====================================================================
  // 分页
  // =====================================================================

  async _nextPage(proxy, targetId) {
    const r = await proxy.eval(targetId, `
      (() => {
        const btn = document.querySelector('.el-pagination .btn-next');
        if (btn && !btn.disabled) { btn.click(); return true; }
        return false;
      })()
    `);
    await sleep(1500);
    return { action: 'nextPage', ok: r };
  },

  async _gotoPage(proxy, targetId, page) {
    const r = await proxy.eval(targetId, `
      (() => {
        const pages = document.querySelectorAll('.el-pagination .el-pager li');
        for (const p of pages) {
          if (p.textContent.trim() === '${page}') { p.click(); return true; }
        }
        return false;
      })()
    `);
    await sleep(1500);
    return { action: 'gotoPage', page, ok: r };
  },

  // =====================================================================
  // 搜索按钮
  // =====================================================================

  async _clickSearch(proxy, targetId) {
    const found = await proxy.eval(targetId, `
      (() => {
        document.getElementById('__chanmama_tmp')?.removeAttribute('id');
        const btn = document.querySelector('.search-icon')?.closest('.el-button');
        if (btn) { btn.id = '__chanmama_tmp'; return true; }
        return false;
      })()
    `);
    if (!found) return { action: 'search', ok: false };
    const r = await proxy.clickAt(targetId, TMP_SEL);
    return { action: 'search', ok: r.clicked };
  },

  // =====================================================================
  // popover 内元素点击（通用）
  // =====================================================================

  /** 在可见的 popover 中找到匹配文本的元素并 clickAt */
  async _clickPopoverItem(proxy, targetId, popoverSelector, text) {
    const found = await proxy.eval(targetId, `
      (() => {
        document.getElementById('__chanmama_tmp')?.removeAttribute('id');
        const pops = document.querySelectorAll('${popoverSelector}');
        for (const pop of pops) {
          if (pop.style.display === 'none' || !pop.offsetHeight) continue;
          const candidates = pop.querySelectorAll('.item, .el-radio, span');
          for (const el of candidates) {
            const t = el.querySelector('.el-radio__label')?.textContent?.trim() || el.textContent?.trim();
            if (t === '${text}' && el.offsetHeight > 0) {
              el.id = '__chanmama_tmp'; return true;
            }
          }
        }
        return false;
      })()
    `);
    if (!found) return false;
    const r = await proxy.clickAt(targetId, TMP_SEL);
    return r.clicked || false;
  },

  // =====================================================================
  // popover 确定按钮（通用）
  // =====================================================================

  /** 点击当前可见 popover 中的"确定"按钮 */
  async _clickPopoverConfirm(proxy, targetId) {
    const found = await proxy.eval(targetId, `
      (() => {
        document.getElementById('__chanmama_tmp')?.removeAttribute('id');
        const pops = document.querySelectorAll('.el-popover');
        for (const pop of pops) {
          if (pop.style.display === 'none' || !pop.offsetHeight) continue;
          const els = pop.querySelectorAll('span, div, button');
          for (const el of els) {
            if (el.textContent.trim() === '确定' && el.offsetHeight > 0 && el.children.length === 0) {
              el.id = '__chanmama_tmp'; return true;
            }
          }
        }
        return false;
      })()
    `);
    if (found) await proxy.clickAt(targetId, TMP_SEL);
    return found;
  },

  // =====================================================================
  // 筛选状态
  // =====================================================================

  async _getFilterState(proxy, targetId) {
    const state = await proxy.eval(targetId, GET_FILTER_STATE_JS);
    return { action: 'getFilterState', state };
  },

  // =====================================================================
  // 达人详情页 — 简介提取
  // =====================================================================

  /**
   * 提取达人简介，自动处理长文本展开
   * DOM 结构:
   *   .personal-intro-row
   *     span.fs12.c666.mr6  → "达人简介" 标签
   *     .intro-content
   *       span.intro-text.fs12.c333  → 简介正文（CSS -webkit-line-clamp:2 截断）
   *       span.more-link.fs12        → "复制" 或 "展开"
   * Vue 数据:
   *   isMore: false → 未展开, true → 已展开
   *   noMore: true → 文本无溢出, false → 文本有溢出需展开
   */
  async _extractBio(proxy, targetId) {
    // 等待详情页加载完成
    const ready = await this._waitForDetailReady(proxy, targetId);
    if (!ready) return { action: 'extractBio', error: 'detail page not loaded' };

    // 检查是否有溢出文本需要展开
    const expandState = await proxy.eval(targetId, `
      (() => {
        const row = document.querySelector('.personal-intro-row');
        if (!row) return { hasRow: false };

        const introText = row.querySelector('.intro-text');
        if (!introText) return { hasRow: true, hasText: false };

        // 检查 CSS 截断状态
        const isTruncated = introText.scrollHeight > introText.clientHeight;

        // 检查 Vue 组件的展开状态
        let el = row;
        while (el && !el.__vue__) el = el.parentElement;
        const vm = el?.__vue__;
        const isMore = vm?.$data?.isMore ?? false;
        const noMore = vm?.$data?.noMore ?? true;

        // 在 intro-content 中查找"展开"按钮
        const introContent = row.querySelector('.intro-content');
        const spans = introContent?.querySelectorAll('span') || [];
        let expandBtn = null;
        for (const s of spans) {
          const t = s.textContent?.trim();
          if (t === '展开' || t === '查看更多') {
            expandBtn = t;
            break;
          }
        }

        return { hasRow: true, hasText: true, isTruncated, isMore, noMore, expandBtn };
      })()
    `);

    // 如果文本被截断且未展开，尝试点击展开
    if (expandState?.isTruncated && !expandState?.isMore) {
      // 方式1: 点击展开按钮
      if (expandState.expandBtn) {
        const found = await proxy.eval(targetId, `
          (() => {
            document.getElementById('__chanmama_tmp')?.removeAttribute('id');
            const content = document.querySelector('.personal-intro-row .intro-content');
            const spans = content?.querySelectorAll('span') || [];
            for (const s of spans) {
              const t = s.textContent?.trim();
              if (t === '展开' || t === '查看更多') {
                s.id = '__chanmama_tmp'; return true;
              }
            }
            return false;
          })()
        `);
        if (found) {
          await proxy.clickAt(targetId, TMP_SEL);
          await sleep(500);
        }
      }

      // 方式2: 直接移除 CSS 截断（兜底，确保能拿到完整文本）
      await proxy.eval(targetId, `
        (() => {
          const introText = document.querySelector('.personal-intro-row .intro-text');
          if (introText) {
            introText.style.webkitLineClamp = 'unset';
            introText.style.overflow = 'visible';
          }
        })()
      `);
      await sleep(200);
    }

    // 提取完整简介文本
    const bio = await proxy.eval(targetId, `
      (() => {
        const introText = document.querySelector('.personal-intro-row .intro-text');
        return introText?.textContent?.trim() || '';
      })()
    `);

    // 恢复 CSS 截断（避免影响页面显示）
    await proxy.eval(targetId, `
      (() => {
        const introText = document.querySelector('.personal-intro-row .intro-text');
        if (introText) {
          introText.style.webkitLineClamp = '';
          introText.style.overflow = '';
        }
      })()
    `);

    return {
      action: 'extractBio',
      bio: bio || '',
      wasTruncated: expandState?.isTruncated || false,
      wasExpanded: expandState?.isTruncated && !expandState?.isMore,
    };
  },

  /** 等待详情页核心 DOM 加载完成 */
  async _waitForDetailReady(proxy, targetId, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ready = await proxy.eval(targetId, `
        !!document.querySelector('.personal-intro-row .intro-text')
      `);
      if (ready) return true;
      await sleep(500);
    }
    return false;
  },
};
