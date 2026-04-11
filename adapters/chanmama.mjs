// AnyReach 蝉妈妈适配器 - chanmama.com
// 支持页面类型：
//   - bloggerRank: 达人库（筛选 + 列表）
//
// 核心功能模块：
//   - applyFilters: 组合筛选条件并搜索
//   - applySavedCondition: 加载已保存的常用条件
//   - extractResults: 提取达人列表数据
//   - nextPage / gotoPage: 翻页
//
// DOM 结构要点 (Vue + Element UI)：
//   - 筛选区: .search-menu > .condition-box > .condition-item (5 rows)
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

// --- helper: 点击包含指定文本的元素 ---
const clickByText = (selector, text) => `
(() => {
  const els = document.querySelectorAll('${selector}');
  for (const el of els) {
    if (el.textContent.trim() === '${text}') { el.click(); return true; }
  }
  return false;
})()`;

// --- helper: 选中 el-checkbox by label text ---
const clickCheckbox = (containerIdx, label, shouldCheck = true) => `
(() => {
  const container = document.querySelectorAll('.condition-box > .condition-item')[${containerIdx}];
  if (!container) return false;
  const cbs = container.querySelectorAll('.el-checkbox');
  for (const cb of cbs) {
    const lbl = cb.querySelector('.el-checkbox__label')?.textContent?.trim();
    if (lbl === '${label}') {
      const checked = cb.classList.contains('is-checked');
      if (checked !== ${shouldCheck}) cb.click();
      return true;
    }
  }
  return false;
})()`;

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
  const rows = document.querySelectorAll('.condition-box > .condition-item');
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
  description: '蝉妈妈 — 达人库筛选、达人列表提取',

  detect(url) {
    if (/bloggerRank/i.test(url)) return 'bloggerRank';
    if (/\/blogger\/\d+/i.test(url)) return 'bloggerDetail';
    return 'default';
  },

  /**
   * 主入口 — 根据 ctx.action 分发
   * 支持的 action:
   *   - 'applyFilters': 设置筛选条件并搜索 (ctx.filters)
   *   - 'applySavedCondition': 加载保存的条件 (ctx.conditionName)
   *   - 'extractResults': 提取当前页达人列表
   *   - 'extractAll': 提取所有页（带翻页）
   *   - 'getFilterState': 获取当前筛选状态
   *   - 'nextPage': 翻到下一页
   *   - 'gotoPage': 跳转指定页 (ctx.page)
   *   - 'search': 点击搜索按钮
   */
  async extract(proxy, targetId, ctx) {
    const action = ctx.action || 'extractResults';

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
   * @param {Object} filters - 筛选条件:
   *   - category {string} 带货分类一级（如 "日用百货"）
   *   - subCategory {string} 带货分类二级（如 "个人护理"）
   *   - bloggerGender {string} 达人画像性别："不限"|"男"|"女"
   *   - fanGender {string} 粉丝画像性别："全部"|"男性居多"|"女性居多"
   *   - checkDaren {boolean} 勾选达人号
   *   - levels {string[]} 带货等级 ["LV1","LV2","LV3","LV4"]
   *   - sellMode {string} 带货方式："直播带货为主"|"视频带货为主"|"图文带货为主"
   *   - liveHourlyOutput {string} 直播场均小时产出范围（需展开"直播表现"）
   */
  async _applyFilters(proxy, targetId, filters) {
    const results = [];

    // 1. 带货分类 — 一级
    if (filters.category) {
      const clicked = await proxy.eval(targetId,
        clickByText('.condition-box > .condition-item:first-child .flex-flow-row-wrap span', filters.category)
      );
      results.push({ step: 'category', value: filters.category, ok: clicked });

      // 二级分类 — 需要等 popover 弹出
      if (filters.subCategory) {
        await sleep(500);
        // 二级分类面板是 popover，找到并点击
        const subClicked = await proxy.eval(targetId, `
          (() => {
            // popover 在 document.body 末尾，找最后出现的分类面板
            const popovers = document.querySelectorAll('.author-thread-category-popover, .el-popover');
            for (const pop of popovers) {
              if (pop.style.display === 'none') continue;
              const items = pop.querySelectorAll('.category-item, span, div');
              for (const item of items) {
                if (item.textContent.trim() === '${filters.subCategory}') {
                  item.click();
                  return true;
                }
              }
            }
            return false;
          })()
        `);
        results.push({ step: 'subCategory', value: filters.subCategory, ok: subClicked });
        await sleep(300);
      }
    }

    // 2. 达人画像 — 性别 (row2, section 0)
    if (filters.bloggerGender) {
      const r = await proxy.eval(targetId, `
        (() => {
          const sec = document.querySelectorAll('.condition-box > .condition-item')[2]?.children[1]?.children[0];
          if (!sec) return false;
          const radios = sec.querySelectorAll('.el-radio');
          for (const r of radios) {
            if (r.querySelector('.el-radio__label')?.textContent?.trim() === '${filters.bloggerGender}') {
              r.click(); return true;
            }
          }
          return false;
        })()
      `);
      results.push({ step: 'bloggerGender', value: filters.bloggerGender, ok: r });
    }

    // 3. 粉丝画像 — 性别 (row2, section 1)
    if (filters.fanGender) {
      const r = await proxy.eval(targetId, `
        (() => {
          const sec = document.querySelectorAll('.condition-box > .condition-item')[2]?.children[1]?.children[1];
          if (!sec) return false;
          const radios = sec.querySelectorAll('.el-radio');
          for (const r of radios) {
            if (r.querySelector('.el-radio__label')?.textContent?.trim() === '${filters.fanGender}') {
              r.click(); return true;
            }
          }
          return false;
        })()
      `);
      results.push({ step: 'fanGender', value: filters.fanGender, ok: r });
    }

    // 4. 达人号 checkbox (row2)
    if (filters.checkDaren) {
      const r = await proxy.eval(targetId, clickCheckbox(2, '达人号', true));
      results.push({ step: 'checkDaren', ok: r });
    }

    // 5. 带货等级 — multi-select dropdown (row3, section 0)
    if (filters.levels && filters.levels.length > 0) {
      // 先点击 select 打开下拉
      const r = await proxy.eval(targetId, `
        (() => {
          const sec = document.querySelectorAll('.condition-box > .condition-item')[3]?.children[1]?.children[0];
          if (!sec) return false;
          const select = sec.querySelector('.common-search-multiple-select, .common-search-select');
          if (select) { select.click(); return true; }
          return false;
        })()
      `);
      results.push({ step: 'openLevelSelect', ok: r });
      await sleep(500);

      // 在弹出的 popover 中选择等级
      for (const level of filters.levels) {
        const lr = await proxy.eval(targetId, `
          (() => {
            // popover 在 body 末尾
            const pops = document.querySelectorAll('.common-search-multiple-select-popover, .el-popover');
            for (const pop of pops) {
              if (pop.style.display === 'none' || !pop.offsetHeight) continue;
              const items = pop.querySelectorAll('.item, span, li, .el-checkbox');
              for (const item of items) {
                const text = item.textContent.trim();
                if (text === '${level}') {
                  item.click(); return true;
                }
              }
            }
            return false;
          })()
        `);
        results.push({ step: 'level', value: level, ok: lr });
        await sleep(200);
      }

      // 关闭下拉：点击其他区域
      await proxy.eval(targetId, `document.querySelector('.condition-box .lab')?.click()`);
      await sleep(300);
    }

    // 6. 带货方式 (row3, section 1)
    if (filters.sellMode) {
      const r = await proxy.eval(targetId, `
        (() => {
          const sec = document.querySelectorAll('.condition-box > .condition-item')[3]?.children[1]?.children[1];
          if (!sec) return false;
          const select = sec.querySelector('.common-search-select');
          if (select) { select.click(); return true; }
          return false;
        })()
      `);
      results.push({ step: 'openSellModeSelect', ok: r });
      await sleep(500);

      const sr = await proxy.eval(targetId, `
        (() => {
          const pops = document.querySelectorAll('.common-search-select-popover, .el-popover');
          for (const pop of pops) {
            if (pop.style.display === 'none' || !pop.offsetHeight) continue;
            const items = pop.querySelectorAll('.item, span, li');
            for (const item of items) {
              if (item.textContent.trim() === '${filters.sellMode}') {
                item.click(); return true;
              }
            }
          }
          return false;
        })()
      `);
      results.push({ step: 'sellMode', value: filters.sellMode, ok: sr });
      await sleep(300);
    }

    // 7. 直播场均小时产出 — 需要先展开"直播表现"再选择
    if (filters.liveHourlyOutput) {
      // 点击"直播表现"展开
      const expandR = await proxy.eval(targetId, `
        (() => {
          const items = document.querySelectorAll('.condition-box .input-box');
          for (const item of items) {
            if (item.textContent.trim().includes('直播表现')) {
              item.click(); return true;
            }
          }
          return false;
        })()
      `);
      results.push({ step: 'expandLivePerf', ok: expandR });
      await sleep(500);

      // 在展开的面板中找到"直播场均小时产出"并设置
      const lr = await proxy.eval(targetId, `
        (() => {
          const pops = document.querySelectorAll('.el-popover, [class*=popover]');
          for (const pop of pops) {
            if (pop.style.display === 'none' || !pop.offsetHeight) continue;
            const text = pop.textContent;
            if (text.includes('场均小时产出') || text.includes('小时产出')) {
              // 找到对应的 select 并选择
              const selects = pop.querySelectorAll('.common-search-select, select');
              // 需要具体的交互逻辑 — 取决于该下拉的 DOM 结构
              return { found: true, hasSelects: selects.length };
            }
          }
          return { found: false };
        })()
      `);
      results.push({ step: 'liveHourlyOutput', value: filters.liveHourlyOutput, detail: lr });
    }

    // 8. 点击搜索
    await this._clickSearch(proxy, targetId);
    await sleep(1500);

    return { action: 'applyFilters', steps: results };
  },

  // =====================================================================
  // 加载保存的条件
  // =====================================================================

  /**
   * 点击已保存的常用条件（如"阿周"）
   */
  async _applySavedCondition(proxy, targetId, name) {
    if (!name) return { error: 'conditionName is required' };

    const r = await proxy.eval(targetId, `
      (() => {
        const items = document.querySelectorAll('.save-condition-item');
        for (const item of items) {
          const text = item.textContent.replace('重命名', '').replace('删除', '').trim();
          if (text === '${name}') {
            item.click();
            return true;
          }
        }
        return false;
      })()
    `);

    if (!r) return { error: `saved condition "${name}" not found` };

    await sleep(1500);
    return { action: 'applySavedCondition', name, ok: true };
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
    // 搜索按钮是 .search-icon 所在的 el-button
    const r = await proxy.eval(targetId, `
      (() => {
        const icon = document.querySelector('.search-icon');
        if (!icon) return false;
        // 向上找到 button 祖先
        const btn = icon.closest('.el-button') || icon.parentElement;
        if (btn) { btn.click(); return true; }
        icon.click();
        return true;
      })()
    `);
    return { action: 'search', ok: r };
  },

  // =====================================================================
  // 筛选状态
  // =====================================================================

  async _getFilterState(proxy, targetId) {
    const state = await proxy.eval(targetId, GET_FILTER_STATE_JS);
    return { action: 'getFilterState', state };
  },
};
