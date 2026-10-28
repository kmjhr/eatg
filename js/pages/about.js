/* ==========================================================================
   一咕（EATG）· 关于与隐私页（js/pages/about.js）
   实现：《页面线框与UI规范》P22
   路由：#/about
   内容：品牌区（图标/名称/版本）+ 隐私说明 + 致谢与免责声明
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  function resetState() { state = { destroyed: false }; }

  function pageHTML() {
    return '<div class="about-page">' +
      '<div class="about-brand">' +
        '<div class="about-logo">咕</div>' +
        '<div class="about-name">一咕 EATG</div>' +
        '<div class="about-ver">v1.0.0</div>' +
      '</div>' +

      '<div class="about-section">' +
        '<div class="about-section-title">隐私承诺</div>' +
        '<ul class="about-list">' +
          '<li>所有收藏与图片数据仅存储于本机浏览器（IndexedDB），<b>不上传任何服务器</b>。</li>' +
          '<li>上传图片时自动压缩并<b>剥离 EXIF 信息</b>，不保留拍摄位置与设备数据。</li>' +
          '<li>行情等网络请求<b>不含任何收藏数据</b>，仅用于获取公开行情参考。</li>' +
          '<li>导出 / 备份文件由你自行保管，清除浏览器数据将无法恢复。</li>' +
        '</ul>' +
      '</div>' +

      '<div class="about-section">' +
        '<div class="about-section-title">数据安全</div>' +
        '<ul class="about-list">' +
          '<li>金额一律以「分」整数存储，展示层换算，避免浮点误差。</li>' +
          '<li>恢复备份前自动导出当前数据为 <code>.pre-restore-时间戳</code> 文件。</li>' +
          '<li>删除操作一律二次确认；恢复操作校验 app 与 version。</li>' +
        '</ul>' +
      '</div>' +

      '<div class="about-section">' +
        '<div class="about-section-title">致谢与免责</div>' +
        '<p class="about-p">感谢 MyGO!!!!!、BanG Dream! 等 IP 带来的美好作品。</p>' +
        '<p class="about-p about-disclaimer">本工具为个人开发的谷子收藏管理助手，与上述 IP 及官方<b>无任何隶属或赞助关系</b>。所有 IP 名称、角色名称及相关版权归原版权方所有。</p>' +
      '</div>' +

      '<div class="about-footer">一咕 EATG · 纯前端 · 本机存储</div>' +
    '</div>';
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    ctx.setTitle('关于与隐私');
    ctx.setBack(true);
    ctx.setActiveTab('mine');
    ctx.navActions.innerHTML = '';
    container.innerHTML = pageHTML();
    return Promise.resolve();
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['about'] = { key: 'about', mount: mount, unmount: unmount };

})(window);
