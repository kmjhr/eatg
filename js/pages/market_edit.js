/* ==========================================================================
   一咕（EATG）· 行情录入（js/pages/market_edit.js）
   实现：《页面线框与UI规范》P13
   路由：#/market/add?goods_id=  （新增）
        #/market/add?id=          （编辑已有行情）
   表单：谷子（关联已有 / 自由输入新建）、平台、价格（元）、品相、记录日期、备注
   保存：写入 price_records；并将 goods.market_price 更新为该谷子最新一条行情价。
   预填：goods_id 锁定谷子；从资讯进入可带 price/platform/name。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var PLATFORMS = ['闲鱼', '淘宝', '煤炉', '日拍', '实体店', '其他'];
  var CONDITIONS = ['全新', '未拆', '拆摆', '瑕', '其他'];

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function yuanToCents(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100);
  }
  function centsToYuan(cents) {
    if (cents == null || !isFinite(Number(cents))) return '';
    var fixed = (Number(cents) / 100).toFixed(2);
    return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function resetState() {
    state = {
      destroyed: false,
      mode: 'add',          // add / edit
      recordId: null,
      goods: [],            // 已有谷子列表
      record: {
        goods_id: null,
        platform: '',
        price: null,        // 分
        condition: '',
        record_date: U.todayStr(),
        note: ''
      },
      freeInput: false,     // 是否自由输入谷子名
      freeName: ''          // 自由输入的谷子名
    };
  }

  function load(ctx) {
    var params = new URLSearchParams(ctx.query);
    var id = params.get('id');
    var gid = params.get('goods_id');
    return S.getAll('goods').then(function (list) {
      state.goods = list || [];
      if (id) {
        // 编辑模式
        state.mode = 'edit';
        state.recordId = Number(id);
        return S.get('price_records', state.recordId).then(function (rec) {
          if (!rec) throw new Error('行情记录不存在');
          state.record.goods_id = rec.goods_id;
          state.record.platform = rec.platform || '';
          state.record.price = rec.price;
          state.record.condition = rec.condition || '';
          state.record.record_date = rec.record_date || U.todayStr();
          state.record.note = rec.note || '';
        });
      }
      // 新增模式：预填
      state.mode = 'add';
      if (gid) state.record.goods_id = Number(gid);
      var p = params.get('price');
      if (p != null && p !== '') state.record.price = yuanToCents(p);
      var plat = params.get('platform');
      if (plat) state.record.platform = plat;
      var name = params.get('name');
      if (name) { state.freeName = name; state.freeInput = true; }
    });
  }

  function goodsOpts() {
    var opts = '<option value="">请选择谷子款</option>';
    opts += state.goods.map(function (g) {
      return '<option value="' + g.id + '"' + (state.record.goods_id === g.id ? ' selected' : '') + '>' +
        esc(g.name || ('谷子#' + g.id)) + (g.ip ? '（' + esc(g.ip) + '）' : '') + '</option>';
    }).join('');
    opts += '<option value="__free__"' + (state.freeInput ? ' selected' : '') + '>＋ 自由输入（新建谷子款）</option>';
    return opts;
  }

  function platformOpts() {
    var opts = '<option value="">请选择平台</option>';
    opts += PLATFORMS.map(function (p) {
      return '<option value="' + esc(p) + '"' + (state.record.platform === p ? ' selected' : '') + '>' + esc(p) + '</option>';
    }).join('');
    return opts;
  }

  function conditionOpts() {
    var opts = '<option value="">请选择品相</option>';
    opts += CONDITIONS.map(function (c) {
      return '<option value="' + esc(c) + '"' + (state.record.condition === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    return opts;
  }

  function pageHTML() {
    var r = state.record;
    var priceYuan = centsToYuan(r.price);
    var lockedGoods = state.mode === 'edit' || state.record.goods_id != null;
    return '<div class="page-scroll" id="mkt-edit-page">' +
      '<div class="form-section">' +
        '<div class="field"><div class="field-head"><label class="field-label">谷子款</label></div>' +
          (lockedGoods
            ? '<input id="me-goods" class="input is-readonly" readonly value="' + esc(goodsName()) + '">'
            : '<select id="me-goods" class="input">' + goodsOpts() + '</select>') +
          (state.freeInput ? '<input id="me-free-name" class="input" type="text" placeholder="输入谷子名称（将新建谷子款）" value="' + esc(state.freeName) + '" style="margin-top:8px">' : '') +
          '<p class="hint">选择已有谷子款，或自由输入名称新建</p>' +
        '</div>' +
        '<div class="field"><div class="field-head"><label class="field-label">平台</label></div>' +
          '<select id="me-platform" class="input">' + platformOpts() + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">价格（元）</label></div>' +
          '<div class="money-input"><input id="me-price" class="input" type="text" inputmode="decimal" placeholder="0.00" value="' + esc(priceYuan) + '"><span class="money-unit">元</span></div>' +
          '<p class="hint">成交价或挂价，保存为「分」整数</p></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">品相</label></div>' +
          '<select id="me-condition" class="input">' + conditionOpts() + '</select></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">记录日期</label></div>' +
          '<input id="me-date" class="input" type="date" value="' + esc(r.record_date) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">备注</label></div>' +
          '<textarea id="me-note" class="textarea" rows="3" placeholder="可选">' + esc(r.note) + '</textarea></div>' +
      '</div>' +
      '<div class="detail-actions">' +
        (state.mode === 'edit' ? '<button type="button" class="btn btn--danger" data-act="del">删除</button>' : '') +
        '<button type="button" class="btn btn--primary" data-act="save">保存</button>' +
      '</div>' +
    '</div>';
  }

  function goodsName() {
    var g = state.goods.filter(function (x) { return x.id === state.record.goods_id; })[0];
    return g ? (g.name || ('谷子#' + g.id)) : '';
  }

  function cacheDom() {
    var p = document.getElementById('mkt-edit-page');
    dom.page = p;
    dom.goods = p.querySelector('#me-goods');
    dom.freeName = p.querySelector('#me-free-name');
    dom.platform = p.querySelector('#me-platform');
    dom.price = p.querySelector('#me-price');
    dom.condition = p.querySelector('#me-condition');
    dom.date = p.querySelector('#me-date');
    dom.note = p.querySelector('#me-note');
  }

  function bind() {
    if (dom.goods && dom.goods.tagName === 'SELECT') {
      on(dom.goods, 'change', function () {
        var v = dom.goods.value;
        if (v === '__free__') {
          state.freeInput = true;
          state.record.goods_id = null;
        } else {
          state.freeInput = false;
          state.record.goods_id = v ? Number(v) : null;
        }
        rerender();
      });
    }
    on(dom.page, 'click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'save') doSave();
      else if (act.dataset.act === 'del') doDel();
    });
  }

  function collectForm() {
    var r = state.record;
    if (dom.goods && dom.goods.tagName === 'SELECT') {
      var v = dom.goods.value;
      state.freeInput = (v === '__free__');
      r.goods_id = state.freeInput ? null : (v ? Number(v) : null);
    }
    if (state.freeInput && dom.freeName) {
      state.freeName = dom.freeName.value.trim();
    }
    r.platform = dom.platform.value;
    r.price = yuanToCents(dom.price.value);
    r.condition = dom.condition.value;
    r.record_date = dom.date.value || U.todayStr();
    r.note = dom.note.value.trim();
  }

  function validate() {
    collectForm();
    var r = state.record;
    if (state.freeInput) {
      if (!state.freeName) { UI.toast('请输入谷子名称', 'error'); return false; }
    } else if (!r.goods_id) {
      UI.toast('请选择谷子款', 'error'); return false;
    }
    if (r.price == null || isNaN(r.price) || r.price < 0) {
      UI.toast('请填写有效的价格（最多两位小数）', 'error'); return false;
    }
    if (!r.platform) { UI.toast('请选择平台', 'error'); return false; }
    if (!r.record_date) { UI.toast('请选择记录日期', 'error'); return false; }
    return true;
  }

  function doSave() {
    if (!validate()) return;
    var r = state.record;
    var p;
    if (state.mode === 'edit') {
      p = S.put('price_records', {
        id: state.recordId,
        goods_id: r.goods_id,
        platform: r.platform,
        price: r.price,
        condition: r.condition,
        record_date: r.record_date,
        note: r.note
      });
    } else {
      // 新增：若自由输入，先创建 goods
      var goodsPromise;
      if (state.freeInput) {
        goodsPromise = S.add('goods', {
          name: state.freeName,
          ip: '其他',
          goods_type: '其他',
          character_ids: [],
          images: [],
          tags: [],
          note: ''
        }).then(function (id) { r.goods_id = Number(id); return id; });
      } else {
        goodsPromise = Promise.resolve(r.goods_id);
      }
      p = goodsPromise.then(function () {
        return S.add('price_records', {
          goods_id: r.goods_id,
          platform: r.platform,
          price: r.price,
          condition: r.condition,
          record_date: r.record_date,
          note: r.note
        });
      });
    }
    p.then(function () {
      return recomputeMarketPrice(r.goods_id);
    }).then(function () {
      UI.toast('已保存', 'success');
      goBack();
    }).catch(function (err) {
      UI.toast('保存失败：' + (err && err.message || err), 'error');
    });
  }

  function doDel() {
    UI.confirmDialog({
      title: '删除行情',
      message: '删除后该谷子的估值与走势将同步更新，确认删除？',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var gid = state.record.goods_id;
      S.del('price_records', state.recordId).then(function () {
        return recomputeMarketPrice(gid);
      }).then(function () {
        UI.toast('已删除', 'success');
        goBack();
      }).catch(function (err) {
        UI.toast('删除失败：' + (err && err.message || err), 'error');
      });
    });
  }

  /** 重新计算指定 goods 的 market_price（取最新一条行情） */
  function recomputeMarketPrice(gid) {
    return S.get('goods', gid).then(function (g) {
      if (!g) return;
      return S.query('price_records', 'goods_id', gid).then(function (list) {
        list.sort(function (a, b) {
          if (a.record_date !== b.record_date) return (b.record_date || '').localeCompare(a.record_date || '');
          return num(b.created_at) - num(a.created_at);
        });
        if (list.length) {
          g.market_price = num(list[0].price);
        } else {
          delete g.market_price;
        }
        return S.put('goods', g);
      });
    });
  }

  function goBack() {
    if (state.record.goods_id) {
      if (EATG.app && EATG.app.navigate) EATG.app.navigate('#/market/detail?goods_id=' + state.record.goods_id);
    } else if (EATG.app) {
      EATG.app.navigate('#/market');
    }
  }

  function rerender() {
    var container = dom.container;
    if (!container) return;
    container.innerHTML = pageHTML();
    cacheDom();
    bind();
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle(state.mode === 'edit' ? '编辑行情' : '录入行情');
    ctx.setBack(true);
    ctx.setActiveTab('market');
    return load(ctx).then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      cacheDom();
      bind();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 行情录入加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['market/add'] = { key: 'market/add', mount: mount, unmount: unmount };

})(window);
