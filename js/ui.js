/* ==========================================================================
   一咕（EATG）· 共享 UI 组件（js/ui.js）
   提供：toast（底部2秒自动消失）、confirmDialog（居中确认弹窗，危险红色）、
        sheet（底部半屏抽屉，max-height:70vh）。
   依据《页面线框与UI规范》§2 全局组件；供各页面复用。
   约束：无外链资源；仅操作本机 DOM。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var UI = (EATG.ui = EATG.ui || {});

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  UI.esc = esc;

  function rootEl() { return document.getElementById('modal-root'); }

  function maybeHideRoot() {
    var root = rootEl();
    if (root && !root.children.length) root.hidden = true;
  }

  // ---- Toast（底部，2秒自动消失） ----

  /**
   * @param {string} msg 文案
   * @param {'success'|'error'|''} [type] 类型（决定图标与边色）
   * @param {number} [ms] 停留毫秒，默认 2000
   */
  function toast(msg, type, ms) {
    var c = document.getElementById('toast-container');
    if (!c) {
      if (type === 'error') console.error('[EATG]', msg);
      else console.log('[EATG]', msg);
      return;
    }
    // 单例替换：新 toast 顶掉旧 toast，避免连续操作堆叠刷屏
    while (c.firstChild) c.removeChild(c.firstChild);
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast--' + type : '');
    var mark = type === 'success' ? '✓ ' : (type === 'error' ? '✕ ' : '');
    el.textContent = mark + (msg == null ? '' : String(msg));
    c.appendChild(el);
    setTimeout(function () {
      el.classList.add('toast--out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
    }, ms || 2000);
  }

  // ---- 确认弹窗（居中：标题 + 说明 + 取消/确认；危险操作红色确认） ----

  /**
   * @param {{title?:string, message?:string, confirmText?:string, cancelText?:string, danger?:boolean}} opts
   * @returns {Promise<boolean>} 确认=true / 取消=false
   */
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var root = rootEl();
      if (!root) { // 极端兜底
        resolve(global.confirm ? !!global.confirm(opts.message || opts.title || '确认？') : true);
        return;
      }
      root.hidden = false;

      var layer = document.createElement('div');
      layer.className = 'modal-layer';
      layer.innerHTML =
        '<div class="modal-card" role="dialog" aria-modal="true">' +
          '<h3 class="modal-title">' + esc(opts.title || '确认') + '</h3>' +
          (opts.message ? '<p class="modal-text">' + esc(opts.message) + '</p>' : '') +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn--secondary" data-act="cancel">' + esc(opts.cancelText || '取消') + '</button>' +
            '<button type="button" class="btn ' + (opts.danger ? 'btn--danger' : 'btn--primary') + '" data-act="ok">' + esc(opts.confirmText || '确认') + '</button>' +
          '</div>' +
        '</div>';
      root.appendChild(layer);

      var card = layer.querySelector('.modal-card');

      function onKey(e) { if (e.key === 'Escape') done(false); }
      function onBackdrop(e) { if (e.target === layer) done(false); }
      function done(v) {
        document.removeEventListener('keydown', onKey);
        layer.removeEventListener('click', onBackdrop);
        if (layer.parentNode) layer.parentNode.removeChild(layer);
        maybeHideRoot();
        resolve(v);
      }

      card.querySelector('[data-act="cancel"]').addEventListener('click', function () { done(false); });
      card.querySelector('[data-act="ok"]').addEventListener('click', function () { done(true); });
      layer.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
      setTimeout(function () { var ok = card.querySelector('[data-act="ok"]'); if (ok) ok.focus(); }, 0);
    });
  }

  // ---- 底部抽屉（半屏，max-height:70vh；多选标签 + 重置/确定 等） ----

  /**
   * @param {{title?:string, bodyHTML?:string, bodyNode?:Node, footerHTML?:string}} opts
   * @returns {{el:HTMLElement, body:HTMLElement, foot:HTMLElement, close:function}}
   */
  function sheet(opts) {
    opts = opts || {};
    var root = rootEl();
    root.hidden = false;

    var backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    var panel = document.createElement('div');
    panel.className = 'sheet';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML =
      '<div class="sheet-grip" aria-hidden="true"></div>' +
      (opts.title
        ? '<div class="sheet-head"><h3 class="sheet-title">' + esc(opts.title) + '</h3>' +
          '<button type="button" class="sheet-close" aria-label="关闭">✕</button></div>'
        : '') +
      '<div class="sheet-body"></div>' +
      (opts.footerHTML ? '<div class="sheet-foot">' + opts.footerHTML + '</div>' : '');

    var body = panel.querySelector('.sheet-body');
    if (opts.bodyHTML) body.innerHTML = opts.bodyHTML;
    if (opts.bodyNode) body.appendChild(opts.bodyNode);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.classList.add('sheet-backdrop--out');
      panel.classList.add('sheet--out');
      setTimeout(function () {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        maybeHideRoot();
      }, 200);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    var closeBtn = panel.querySelector('.sheet-close');
    if (closeBtn) closeBtn.addEventListener('click', close);

    // 进场动画
    requestAnimationFrame(function () {
      backdrop.classList.add('sheet-backdrop--in');
      panel.classList.add('sheet--in');
    });

    return {
      el: panel,
      body: body,
      foot: panel.querySelector('.sheet-foot'),
      close: close
    };
  }

  UI.toast = toast;
  UI.confirmDialog = confirmDialog;
  UI.sheet = sheet;

})(window);
