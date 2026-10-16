/* ==========================================================================
   一咕（EATG）· Service Worker（js/sw.js）
   能力：离线壳缓存 + 应用更新。
   策略：导航请求网络优先、回退缓存首页；静态资源缓存优先、网络回退。
   注意：数据在 IndexedDB，与缓存无关；sw 仅负责页面壳与静态资源。
   ========================================================================== */
'use strict';

var CACHE = 'eatg-shell-v43';
var PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/main.css',
  './js/utils.js',
  './js/storage.js',
  './js/ui.js',
  './js/agg.js',
  './js/app.js',
  './js/reminder.js',
  './js/gallery_import.js',
  './js/batch_scan.js',
  './js/dev_seed.js',
  './js/pages/library.js',
  './js/pages/goods_edit.js',
  './js/pages/goods_detail.js',
  './js/pages/goods_batch.js',
  './js/pages/orders.js',
  './js/pages/order_edit.js',
  './js/pages/sales.js',
  './js/pages/sale_edit.js',
  './js/pages/stats.js',
  './js/pages/gallery.js',
  './js/pages/gallery_edit.js',
  './js/pages/market.js',
  './js/pages/market_detail.js',
  './js/pages/market_edit.js',
  './js/pages/news.js',
  './js/pages/news_edit.js',
  './js/pages/sources.js',
  './js/pages/wishlist.js',
  './js/pages/mine.js',
  './js/pages/settings.js',
  './js/pages/data.js',
  './js/pages/about.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 不处理跨域（数据层无外部请求）
  if (url.pathname.indexOf('/icons/') >= 0) return;  // 图标走浏览器 HTTP 缓存即可

  // 导航请求：网络优先，失败回退缓存首页（离线可打开 App）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // 静态资源：缓存优先，网络回退并存入缓存
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    })
  );
});
