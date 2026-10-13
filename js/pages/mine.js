/* ==========================================================================
   一咕（EATG）· 我的首页（js/pages/mine.js）
   实现：《页面线框与UI规范》P18 + 《业务规则》§8
   路由：#/mine
   内容：1 头部：产品名/版本号/收藏概览（件数/投入/盈利）
        2 功能入口列表：统计、订单、卖出订单、数据管理、设置、关于
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var U = EATG.utils;
  var UI = EATG.ui;
  var A = EATG.agg;

  EATG.pages = EATG.pages || {};

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(c) { return U.fmtMoney(c, 'CNY'); }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function resetState() {
    state = { destroyed: false, summary: null };
  }

  function load() {
    return A.buildModel().then(function (model) {
      state.summary = model.summary;
    });
  }

  function headHTML() {
    var s = state.summary || {};
    return '<div class="mine-head">' +
      '<div class="mine-brand">' +
        '<div class="mine-logo">咕</div>' +
        '<div class="mine-brand-text">' +
          '<div class="mine-name">一咕 EATG</div>' +
          '<div class="mine-ver">v1.0.0 · 本机纯前端</div>' +
        '</div>' +
      '</div>' +
      '<div class="mine-overview">' +
        '<div class="mine-ov-item"><div class="mine-ov-value">' + esc(num(s.net_qty)) + '</div><div class="mine-ov-label">件数</div></div>' +
        '<div class="mine-ov-item"><div class="mine-ov-value">' + esc(money(num(s.filled_cost))) + '</div><div class="mine-ov-label">投入</div></div>' +
        '<div class="mine-ov-item"><div class="mine-ov-value">' + esc(money(num(s.total_profit))) + '</div><div class="mine-ov-label">盈利</div></div>' +
      '</div>' +
    '</div>';
  }

  function entryHTML(icon, label, route, hint) {
    return '<a class="mine-entry" href="#/' + route + '">' +
      '<span class="mine-entry-icon">' + icon + '</span>' +
      '<span class="mine-entry-label">' + esc(label) + '</span>' +
      (hint ? '<span class="mine-entry-hint">' + esc(hint) + '</span>' : '') +
      '<span class="mine-entry-arrow">›</span>' +
    '</a>';
  }

  function pageHTML() {
    return '<div class="mine-page">' +
      headHTML() +
      '<div class="mine-entries">' +
        entryHTML('📊', '统计', 'stats', '指标 / 图表 / 盈利排行') +
        entryHTML('📦', '订单', 'orders', '合单与邮费分摊') +
        entryHTML('💰', '卖出订单', 'sales', '卖出记录与收入分摊') +
        entryHTML('💾', '数据管理', 'data', '导出 / 备份 / 恢复') +
        entryHTML('⚙', '设置', 'settings', '币种 / 汇率 / 提醒 / 图片') +
        entryHTML('ℹ', '关于与隐私', 'about', '隐私承诺 / 免责声明') +
      '</div>' +
    '</div>';
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('我的');
    ctx.setBack(false);
    ctx.setActiveTab('mine');
    ctx.navActions.innerHTML = '';
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
    }).catch(function (err) {
      if (state.destroyed) return;
      console.error('[EATG] 我的首页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['mine'] = { key: 'mine', mount: mount, unmount: unmount };

})(window);
