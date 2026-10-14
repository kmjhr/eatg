/* ==========================================================================
   一咕（EATG）· 监控源配置（js/pages/sources.js）
   实现：《页面线框与UI规范》P16 + 《业务规则》§10
   路由：#/sources
   内容：1 说明条：RSS 支持真抓取（直连 + 公共代理）；X/官网自动抓取属二期
        2 列表：名称 / 地址 / 类型 / 启用开关 / 抓取频率 / 立即抓取 / 上次结果
        3 预置 4 源（enabled 默认关）：BanG Dream!官网、武士道官方通贩、官方X、游戏官网
        4 新增 / 编辑 / 删除 / 全部抓取
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var UI = EATG.ui;
  var RSS = EATG.rss;

  EATG.pages = EATG.pages || {};

  var PRESET_SOURCES = [
    { name: 'BanG Dream! 官网', url: 'https://bang-dream.com', type: 'official', enabled: false, fetch_interval: 'daily' },
    { name: '武士道官方通贩', url: 'https://busiroad.jp', type: 'official', enabled: false, fetch_interval: 'daily' },
    { name: '官方 X', url: 'https://x.com', type: 'custom', enabled: false, fetch_interval: 'realtime' },
    { name: '游戏官网', url: 'https://mygo.bang-dream.com', type: 'official', enabled: false, fetch_interval: 'daily' }
  ];

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function resetState() {
    state = { destroyed: false, sources: [], editing: null, fetching: {} };
  }

  function load() {
    return S.getAll('sources').then(function (list) {
      if (!list || !list.length) {
        // 空表 → 写入预置源
        return Promise.all(PRESET_SOURCES.map(function (s) { return S.add('sources', s); })).then(function () {
          return S.getAll('sources');
        });
      }
      return list;
    }).then(function (list) {
      state.sources = list || [];
    });
  }

  function typeLabel(t) {
    if (t === 'official') return '官网';
    if (t === 'rss') return 'RSS';
    return '自定义';
  }

  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function resultHTML(s) {
    var r = s.last_result;
    if (state.fetching[s.id]) return '<span class="src-row-status is-running">抓取中…</span>';
    if (!r) return '<span class="src-row-status muted">未抓取过</span>';
    var text = r.ok
      ? (r.added ? '上次抓到 <b>' + r.added + '</b> 条' + (r.skipped ? '（跳过 ' + r.skipped + ' 条重复）' : '') : '上次无新条目' + (r.skipped ? '（' + r.skipped + ' 条重复）' : ''))
      : '上次失败：' + (r.error || '未知错误');
    return '<span class="src-row-status ' + (r.ok ? 'is-ok' : 'is-bad') + '">' + text + '</span>' +
      (s.last_fetch_at ? '<span class="src-row-status muted">' + fmtTime(s.last_fetch_at) + '</span>' : '');
  }

  function disclaimerHTML() {
    return '<div class="src-disclaimer">' +
      '<b>抓取说明</b>：RSS 源现在可以真实抓取——填 RSS 地址、打开「启用」后，打开资讯页会按频率自动抓取，也可点「立即抓取」手动刷新。' +
      'X / 官网自动抓取仍属二期功能，暂不可用（预置的官网/X 地址不是 RSS，抓取会失败）。' +
      '<span class="src-fetch-all"><button type="button" class="btn btn--primary btn--sm" data-act="fetch-all">全部抓取</button></span>' +
    '</div>';
  }

  function listHTML() {
    if (!state.sources.length) return '<p class="empty-line">暂无监控源</p>';
    return '<div class="src-list">' + state.sources.map(function (s) {
      return '<div class="src-row" data-sid="' + s.id + '">' +
        '<div class="src-row-main">' +
          '<div class="src-row-name">' + esc(s.name) +
            '<span class="src-type-tag src-type--' + esc(s.type) + '">' + typeLabel(s.type) + '</span>' +
          '</div>' +
          '<div class="src-row-url muted">' + esc(s.url) + '</div>' +
          (s.fetch_interval ? '<div class="src-row-freq muted">频率：' + esc(s.fetch_interval) + '</div>' : '') +
          '<div class="src-row-status-wrap">' + resultHTML(s) + '</div>' +
        '</div>' +
        '<div class="src-row-actions">' +
          '<button type="button" class="btn btn--secondary btn--sm" data-act="fetch" data-sid="' + s.id + '"' +
            (state.fetching[s.id] ? ' disabled' : '') + '>' + (state.fetching[s.id] ? '抓取中' : '抓取') + '</button>' +
          '<label class="switch"><input type="checkbox" data-act="toggle" data-sid="' + s.id + '"' + (s.enabled ? ' checked' : '') + '><span class="switch-track"></span></label>' +
          '<button type="button" class="btn btn--secondary btn--sm" data-act="edit" data-sid="' + s.id + '">编辑</button>' +
          '<button type="button" class="btn btn--danger btn--sm" data-act="del" data-sid="' + s.id + '">删除</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function editFormHTML(s) {
    s = s || { name: '', url: '', type: 'rss', enabled: false, fetch_interval: 'daily' };
    return '<div class="form-section">' +
      '<div class="field"><div class="field-head"><label class="field-label">名称 *</label></div>' +
        '<input id="src-name" class="input" type="text" value="' + esc(s.name) + '"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label">RSS 地址 *</label></div>' +
        '<input id="src-url" class="input" type="text" value="' + esc(s.url) + '" placeholder="https://.../feed.xml"></div>' +
      '<div class="field"><div class="field-head"><label class="field-label">类型</label></div>' +
        '<select id="src-type" class="input">' +
          '<option value="rss"' + (s.type === 'rss' ? ' selected' : '') + '>RSS</option>' +
          '<option value="official"' + (s.type === 'official' ? ' selected' : '') + '>官网</option>' +
          '<option value="custom"' + (s.type === 'custom' ? ' selected' : '') + '>自定义</option>' +
        '</select></div>' +
      '<div class="field"><div class="field-head"><label class="field-label">抓取频率</label></div>' +
        '<select id="src-freq" class="input">' +
          '<option value="realtime"' + (s.fetch_interval === 'realtime' ? ' selected' : '') + '>实时（每次打开资讯页）</option>' +
          '<option value="hourly"' + (s.fetch_interval === 'hourly' ? ' selected' : '') + '>每小时</option>' +
          '<option value="daily"' + (s.fetch_interval === 'daily' ? ' selected' : '') + '>每天</option>' +
          '<option value="weekly"' + (s.fetch_interval === 'weekly' ? ' selected' : '') + '>每周</option>' +
        '</select></div>' +
      '<label class="switch"><input id="src-enabled" type="checkbox"' + (s.enabled ? ' checked' : '') + '><span class="switch-track"></span><span class="switch-label">启用（启用后才参与自动抓取）</span></label>' +
      '<div class="detail-actions">' +
        '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="save">保存</button>' +
      '</div>' +
    '</div>';
  }

  function pageHTML() {
    var body = state.editing ? editFormHTML(state.editing) : listHTML();
    return '<div class="page-scroll" id="src-page">' +
      disclaimerHTML() +
      (state.editing ? '<div class="block-head"><h3 class="block-title">' + (state.editing.id ? '编辑监控源' : '新增监控源') + '</h3></div>' : '') +
      body +
    '</div>';
  }

  function render() {
    dom.container.innerHTML = pageHTML();
    bind();
  }

  function go(hash) { if (EATG.app && EATG.app.navigate) EATG.app.navigate(hash); }

  function bind() {
    var page = document.getElementById('src-page');
    if (!page) return;

    on(page, 'click', function (e) {
      var actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      var act = actEl.dataset.act;
      var sid = actEl.dataset.sid ? Number(actEl.dataset.sid) : null;
      if (act === 'toggle') {
        toggleSource(sid, actEl.checked);
      } else if (act === 'fetch') {
        fetchOne(sid);
      } else if (act === 'fetch-all') {
        fetchAll();
      } else if (act === 'edit') {
        var src = state.sources.filter(function (s) { return s.id === sid; })[0];
        state.editing = Object.assign({}, src);
        render();
      } else if (act === 'del') {
        delSource(sid);
      } else if (act === 'cancel') {
        state.editing = null;
        render();
      } else if (act === 'save') {
        saveSource();
      }
    });
  }

  function toggleSource(sid, enabled) {
    var src = state.sources.filter(function (s) { return s.id === sid; })[0];
    if (!src) return;
    src.enabled = enabled;
    S.put('sources', src).then(function () {
      UI.toast(enabled ? '已启用，下次打开资讯页自动抓取' : '已停用', 'success');
    }).catch(function () { UI.toast('操作失败', 'error'); });
  }

  function delSource(sid) {
    UI.confirmDialog({ title: '删除监控源', message: '确认删除该监控源？已抓取的资讯会保留。', confirmText: '删除', danger: true }).then(function (ok) {
      if (!ok) return;
      S.del('sources', sid).then(function () {
        state.sources = state.sources.filter(function (s) { return s.id !== sid; });
        UI.toast('已删除', 'success');
        render();
      }).catch(function () { UI.toast('删除失败', 'error'); });
    });
  }

  function saveSource() {
    var name = document.getElementById('src-name').value.trim();
    var url = document.getElementById('src-url').value.trim();
    var type = document.getElementById('src-type').value;
    var freq = document.getElementById('src-freq').value;
    var enabled = document.getElementById('src-enabled').checked;
    if (!name) { UI.toast('请填写名称', 'error'); return; }
    if (!url) { UI.toast('请填写 RSS 地址', 'error'); return; }
    if (!/^https?:\/\//i.test(url)) { UI.toast('地址需以 http(s):// 开头', 'error'); return; }
    var rec = { name: name, url: url, type: type, enabled: enabled, fetch_interval: freq };
    var p;
    if (state.editing && state.editing.id) {
      rec.id = state.editing.id;
      rec.last_fetch_at = state.editing.last_fetch_at;
      rec.last_result = state.editing.last_result;
      p = S.put('sources', rec);
    } else {
      p = S.add('sources', rec);
    }
    p.then(function () {
      UI.toast('已保存，点「抓取」可立即测试', 'success');
      state.editing = null;
      return load();
    }).then(function () { render(); })
      .catch(function (err) { UI.toast('保存失败：' + (err && err.message || err), 'error'); });
  }

  // ---- 抓取 ----
  function fetchOne(sid) {
    var src = state.sources.filter(function (s) { return s.id === sid; })[0];
    if (!src || state.fetching[sid]) return;
    if (!RSS) { UI.toast('抓取模块未加载', 'error'); return; }
    state.fetching[sid] = true;
    render();
    RSS.fetchSource(src).then(function (res) {
      state.fetching[sid] = false;
      UI.toast(res.ok
        ? (res.added ? '抓到 ' + res.added + ' 条新资讯' + (res.skipped ? '，跳过 ' + res.skipped + ' 条重复' : '') : '没有新条目' + (res.skipped ? '（' + res.skipped + ' 条重复）' : ''))
        : '抓取失败：' + (res.error || '未知错误'),
        res.ok ? 'success' : 'error');
      return load();
    }).then(function () {
      if (state.destroyed) return;
      render();
    }).catch(function (err) {
      state.fetching[sid] = false;
      render();
      UI.toast('抓取出错：' + (err && err.message || err), 'error');
    });
  }

  function fetchAll() {
    var enabled = state.sources.filter(function (s) { return s.enabled; });
    if (!enabled.length) { UI.toast('没有已启用的监控源，先启用至少一个', 'error'); return; }
    var pending = {};
    enabled.forEach(function (s) { pending[s.id] = true; });
    Object.keys(state.fetching).forEach(function (k) { if (state.fetching[k]) pending[k] = true; });
    state.fetching = pending;
    render();
    var chain = Promise.resolve();
    var done = 0;
    enabled.forEach(function (src) {
      chain = chain.then(function () {
        if (state.destroyed) return;
        return RSS.fetchSource(src).then(function (res) {
          if (!state.fetching[src.id]) return;
          state.fetching[src.id] = false;
          if (res.ok && res.added) UI.toast(src.name + '：+ ' + res.added + ' 条', 'success');
          else if (!res.ok) UI.toast(src.name + ' 抓取失败：' + (res.error || ''), 'error');
        }).catch(function () {
          if (state.fetching[src.id]) state.fetching[src.id] = false;
        });
      });
      done++;
    });
    chain.then(function () {
      if (state.destroyed) return;
      UI.toast('全部抓取完成', 'success');
      return load();
    }).then(function () {
      if (state.destroyed) return;
      render();
    }).catch(function () { render(); });
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('监控源');
    ctx.setBack(true);
    ctx.setActiveTab('news');
    ctx.navActions.innerHTML = '<button id="src-add" type="button" class="icon-btn icon-btn--accent" title="新增监控源">＋</button>';
    var addBtn = document.getElementById('src-add');
    if (addBtn) on(addBtn, 'click', function () { state.editing = {}; render(); });
    return load().then(function () {
      if (state.destroyed) return;
      render();
    }).catch(function (err) {
      if (state.destroyed) return;
      if (!(err && err.expected)) console.error('[EATG] 监控源加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['sources'] = { key: 'sources', mount: mount, unmount: unmount };

})(window);
