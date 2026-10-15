/* ==========================================================================
   一咕（EATG）· 应用入口与 hash 路由（js/app.js）
   第 0 步：路由注册表 + 未实现页面“开发中”占位。
   依据《一咕EATG-页面线框与UI规范》§2（Tab栏）/§3（页面线框 P01~P22）。
   约束：hash 路由；未点名页面先渲染占位，不提前实现后续步骤。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});

  // 默认路由
  var DEFAULT_ROUTE = 'library';

  // 底部 Tab 路由顺序（与 index.html 中 5 项一一对应）
  var TAB_ROUTES = ['library', 'gallery', 'market', 'news', 'mine'];

  /**
   * 路由注册表：一级路径 key -> 元信息
   * title：顶部导航标题；tab：对应的底部 Tab 高亮项（可为 null）；
   * desc：占位说明（含对应线框页与实现步骤，便于后续替换为真实页面）。
   */
  var ROUTES = {
    library:  { title: '收藏库',   tab: 'library', desc: '收藏库首页：列表/搜索/筛选/分组（P02 · 第2步 · L-01~L-08）' },
    orders:   { title: '订单',     tab: 'library', desc: '订单列表：合单与邮费分摊（P06 · 第5步 · O-01~O-10）' },
    order:    { title: '订单详情', tab: 'library', desc: '订单详情/新建：分摊模式与平衡校验（P07 · 第5步）' },
    goods:    { title: '谷子款',   tab: 'library', desc: '谷子款详情/新增编辑：聚合+时间线（P03/P04/P05 · 第3、4步）' },

    gallery:  { title: '图鉴',     tab: 'gallery', desc: '角色图鉴：三态+自动点亮（P09/P10 · 第8步 · G-01~G-06）' },

    market:   { title: '行情',     tab: 'market',  desc: '行情：录入+走势+估值（P11/P12/P13 · 第9步 · M-01~M-04）' },

    news:     { title: '资讯',     tab: 'news',    desc: '资讯流/愿望清单/监控源（P14~P17 · 第10步 · N-01~N-05，一期占位）' },
    sources:  { title: '监控源',   tab: 'news',    desc: '监控源配置：一期仅手动添加+RSS占位（P16 · 第10步）' },
    wishlist: { title: '愿望清单', tab: 'news',    desc: '愿望清单：按开订排序，标记已订转收藏库（P17 · 第10步）' },

    mine:     { title: '我的',     tab: 'mine',    desc: '我的首页：概览+功能入口（P18 · 第11步）' },
    sales:    { title: '卖出订单', tab: 'mine',    desc: '卖出记录与卖出订单（P08 · 第6步 · S-01~S-10）' },
    sale:     { title: '卖出订单详情', tab: 'mine', desc: '卖出订单详情/新建：收入分摊与平衡校验（P08 · 第6步）' },
    stats:    { title: '统计',     tab: 'mine',    desc: '统计：指标+图表+盈利排行（P19 · 第7步 · T-01~T-05）' },
    settings: { title: '设置',     tab: 'mine',    desc: '设置：币种/汇率/提醒/图片（P20 · 第11步 · C-01~C-09）' },
    data:     { title: '数据管理', tab: 'mine',    desc: '导出/备份/恢复（P21 · 第11步 · C-04~C-07）' },
    about:    { title: '关于与隐私', tab: 'mine',  desc: '关于与隐私承诺（P22 · 第11步）' }
  };

  // 未注册路由：兜底 404 占位
  var FALLBACK = { title: '页面不存在', tab: null, desc: '' };

  var dom = {};
  var booted = false;
  var currentPage = null;   // 当前挂载的页面模块（用于切换前 unmount）

  // ---- 工具 ----

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 解析当前 hash -> { path, query, segments } */
  function parseHash() {
    var raw = global.location.hash.replace(/^#/, '');
    if (!raw || raw === '/') raw = '/' + DEFAULT_ROUTE;
    if (raw.charAt(0) !== '/') raw = '/' + raw;
    var qIndex = raw.indexOf('?');
    var path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
    var query = qIndex >= 0 ? raw.slice(qIndex + 1) : '';
    var segments = path.split('/').filter(Boolean);
    return { path: path, query: query, segments: segments };
  }

  // ---- 视图更新 ----

  function setTitle(title) {
    if (dom.navTitle) dom.navTitle.textContent = title;
    document.title = title === '一咕（EATG）' ? title : '一咕（EATG） · ' + title;
  }

  function setActiveTab(tabKey) {
    if (!dom.tabBar) return;
    var items = dom.tabBar.querySelectorAll('.tab-item');
    for (var i = 0; i < items.length; i++) {
      var isOn = items[i].getAttribute('data-route') === tabKey;
      items[i].classList.toggle('is-active', isOn);
      items[i].setAttribute('aria-selected', isOn ? 'true' : 'false');
    }
  }

  function setBack(show) {
    if (dom.navBack) dom.navBack.hidden = !show;
  }

  /** 渲染一个占位 section 到页面容器 */
  function renderPlaceholder(cfg) {
    var container = dom.pageContainer;
    if (!container) return;

    // 首次渲染移除首屏骨架屏
    var boot = document.getElementById('boot-skeleton');
    if (boot && boot.parentNode === container) container.removeChild(boot);

    setTitle(cfg.title);

    var displayHash = '#' + cfg.path + (cfg.query ? '?' + cfg.query : '');

    var section = document.createElement('section');
    section.className = 'page';
    section.setAttribute('data-route', displayHash);
    section.innerHTML =
      '<div class="placeholder">' +
        '<div class="placeholder-badge">' + escapeHtml(cfg.badge || '开发中') + '</div>' +
        '<h2 class="placeholder-title">' + escapeHtml(cfg.title) + '</h2>' +
        '<p class="placeholder-desc">' + escapeHtml(cfg.desc) + '</p>' +
        '<p class="placeholder-path">当前路由：' + escapeHtml(displayHash) + '</p>' +
      '</div>';

    container.innerHTML = '';
    container.appendChild(section);

    global.scrollTo(0, 0);
  }

  /** 是否为底部 Tab 一级页（一级页不显示返回箭头，二级页显示） */
  function isTabRoute(key) {
    return TAB_ROUTES.indexOf(key) !== -1;
  }

  /** 清除上一次渲染残留的导航操作区与修饰类 */
  function clearNav() {
    if (dom.navActions) dom.navActions.innerHTML = '';
    if (dom.topNav) dom.topNav.classList.remove('top-nav--search');
  }

  /** 跳转（同 hash 时强制重渲染） */
  function navigate(hash) {
    if (global.location.hash === hash) render();
    else global.location.hash = hash;
  }

  /** 路由渲染 */
  function render() {
    var info = parseHash();
    var key = info.segments[0] || DEFAULT_ROUTE;
    var route = ROUTES[key];

    // 卸载上一个页面（清理监听/定时器/弹窗）
    if (currentPage && currentPage.unmount) {
      try { currentPage.unmount(); } catch (err) { console.error('[EATG] 页面卸载失败:', err); }
    }
    currentPage = null;
    clearNav();

    if (!route) {
      renderPlaceholder({
        title: FALLBACK.title,
        desc: '未注册的路由：#' + info.path,
        path: info.path,
        query: info.query,
        badge: '404'
      });
      setActiveTab(null);
      setBack(info.segments.length > 0);
      return;
    }

    setTitle(route.title);
    setActiveTab(route.tab);
    setBack(!isTabRoute(key));

    // 已注册的页面模块优先渲染，其余仍走“开发中”占位。
    // 支持子路径分派：优先匹配 "一级/二级"（如 goods/edit），否则回退一级（如 library）。
    var pages = EATG.pages || {};
    var subKey = info.segments[1] ? (key + '/' + info.segments[1]) : null;
    var page = (subKey && pages[subKey]) || pages[key];
    if (page && page.mount) {
      var boot = document.getElementById('boot-skeleton');
      if (boot && boot.parentNode) boot.parentNode.removeChild(boot);
      currentPage = page;
      var ctx = {
        key: page.key || key,
        path: info.path,
        query: info.query,
        segments: info.segments,
        container: dom.pageContainer,
        nav: dom.topNav,
        navTitle: dom.navTitle,
        navActions: dom.navActions,
        setTitle: setTitle,
        setBack: setBack,
        setActiveTab: setActiveTab,
        navigate: navigate,
        toast: EATG.ui ? EATG.ui.toast : function () {}
      };
      var p;
      try {
        p = page.mount(dom.pageContainer, ctx);
      } catch (err) {
        console.error('[EATG] 页面挂载失败（同步）:', err);
        if (EATG.ui && EATG.ui.toast) EATG.ui.toast('页面加载失败：' + (err && err.message || err), 'error');
        return;
      }
      if (p && typeof p.then === 'function') {
        p.catch(function (err) {
          if (err && err.expected) return;
          console.error('[EATG] 页面挂载失败（异步）:', err);
          if (EATG.ui && EATG.ui.toast) EATG.ui.toast('页面加载失败：' + (err && err.message || err), 'error');
        });
      }
    } else {
      renderPlaceholder({
        title: route.title,
        desc: route.desc,
        path: info.path,
        query: info.query
      });
    }
  }

  // ---- 启动 ----

  /** 顶部备份提醒条：距上次备份超过周期时显示，点「去备份」直达数据管理，点 × 当天不再弹 */
  function maybeShowBackupBanner(days) {
    try {
      var lastDismiss = Number(global.localStorage.getItem('eatg_backup_banner_dismiss') || 0);
      if (global.Date.now() - lastDismiss < 86400000) return; // 24h 内关过不再弹
      var banner = document.getElementById('backup-banner');
      if (!banner) return;
      var text = document.getElementById('backup-banner-text');
      if (text) {
        text.textContent = days < 0
          ? '还没有备份过，防止数据丢失快去备份'
          : '已 ' + days + ' 天没备份了，防止数据丢失快去备份';
      }
      banner.hidden = false;
    } catch (e) { /* 静默 */ }
  }

  /** 创建备份提醒条 DOM（boot 时挂到 app 根部） */
  function createBackupBanner() {
    var banner = document.createElement('div');
    banner.id = 'backup-banner';
    banner.className = 'backup-banner';
    banner.hidden = true;
    banner.innerHTML =
      '<b id="backup-banner-text"></b>' +
      '<button id="backup-banner-go" type="button" class="btn btn--sm">去备份</button>' +
      '<button id="backup-banner-x" type="button" class="backup-banner-x" aria-label="关闭">×</button>';
    var appEl = document.getElementById('app');
    if (appEl) appEl.appendChild(banner);
    var go = document.getElementById('backup-banner-go');
    if (go) go.addEventListener('click', function () { global.location.hash = '#/data'; });
    var x = document.getElementById('backup-banner-x');
    if (x) x.addEventListener('click', function () {
      banner.hidden = true;
      try { global.localStorage.setItem('eatg_backup_banner_dismiss', String(global.Date.now())); } catch (e) {}
    });
  }

  /** 底部导航：横向滑动切换 Tab（放大镜切换） */
  function initTabSwipe() {
    var bar = dom.tabBar;
    if (!bar) return;
    var startX = null, startY = null, startRoute = null;
    bar.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      if (!t) return;
      startX = t.clientX; startY = t.clientY;
      startRoute = parseHash().segments[0] || DEFAULT_ROUTE;
    }, { passive: true });
    bar.addEventListener('touchmove', function (e) {
      if (startX === null) return;
      var t = e.touches && e.touches[0];
      if (!t) return;
      var cx = t.clientX - startX, cy = t.clientY - startY;
      if (Math.abs(cy) > Math.abs(cx) * 1.2) return;   // 竖向滚动不拦截
      e.preventDefault();
    }, { passive: false });
    bar.addEventListener('touchend', function (e) {
      if (startX === null) return;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      var cx = t.clientX - startX, cy = t.clientY - startY;
      startX = startY = null;
      if (Math.abs(cx) < 40 || Math.abs(cy) > Math.abs(cx)) return;
      var idx = TAB_ROUTES.indexOf(startRoute);
      if (idx < 0) return;
      var next = cx < 0 ? idx + 1 : idx - 1;   // 左滑=下一个
      if (next < 0 || next >= TAB_ROUTES.length) return;
      navigate('#/' + TAB_ROUTES[next]);
    }, { passive: true });
  }

  function boot() {
    if (booted) return;
    booted = true;

    dom.app = document.getElementById('app');
    dom.topNav = document.getElementById('top-nav');
    dom.navTitle = document.getElementById('nav-title');
    dom.navBack = document.getElementById('nav-back');
    dom.navActions = document.getElementById('nav-actions');
    dom.tabBar = document.getElementById('tab-bar');
    initTabSwipe();
    dom.pageContainer = document.getElementById('page-container');

    createBackupBanner();

    if (dom.navBack) {
      dom.navBack.addEventListener('click', function () {
        if (global.history.length > 1) global.history.back();
        else global.location.hash = '#/' + DEFAULT_ROUTE;
      });
    }

    global.addEventListener('hashchange', render);

    // 无 hash 时补默认路由（进入收藏库）
    if (!global.location.hash || global.location.hash === '#') {
      global.location.hash = '#/' + DEFAULT_ROUTE;
    }

    render();

    // 第1步：启动即初始化数据层（建库/建表/种子），失败提示但不阻断骨架渲染
    if (EATG.storage && EATG.storage.initDB) {
      EATG.storage.initDB().then(function () {
        // 启动提醒检查（开订/出荷/补款三类，免打扰时段不弹）
        if (EATG.reminder && EATG.reminder.checkAll) {
          EATG.reminder.checkAll().catch(function (e) {
            console.warn('[EATG] 提醒检查失败:', e);
          });
        }
        // 备份提醒条：开启自动备份提醒且超期未备份时显示
        if (EATG.reminder && EATG.reminder.checkBackup) {
          EATG.reminder.checkBackup().then(function (r) {
            if (r && r.due) maybeShowBackupBanner(r.days);
          }).catch(function (e) {
            console.warn('[EATG] 备份提醒检查失败:', e);
          });
        }
      }).catch(function (err) {
        console.error('[EATG] initDB 失败:', err);
        var msg = '数据层初始化失败：' + (err && err.message || err) + '。请检查浏览器是否禁用了 IndexedDB 或无痕模式数据存储。';
        if (EATG.ui && EATG.ui.toast) EATG.ui.toast(msg, 'error');
        else alert(msg);
      });
    } else {
      var noDbMsg = '当前浏览器不支持 IndexedDB，数据功能不可用。';
      if (EATG.ui && EATG.ui.toast) EATG.ui.toast(noDbMsg, 'error');
      else alert(noDbMsg);
    }

    // 对外暴露，便于后续步骤（第1步起）接入真实页面
    EATG.app = {
      render: render,
      navigate: navigate,
      routes: ROUTES,
      tabs: TAB_ROUTES,
      parseHash: parseHash
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})(window);
