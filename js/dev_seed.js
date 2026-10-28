/* ==========================================================================
   一咕（EATG）· 开发压测工具（js/dev_seed.js）——仅测试用，不进产品页面
   用法：浏览器控制台执行  EATG.devSeed.run()  或  EATG.devSeed.run({goods:5000, items:20000})
   功能：写入指定数量谷子款与购入记录（测试数据，id 从现有最大 id 之后续写，不覆盖真实数据）
   注意：会显著增大数据量，跑之前建议先到「数据管理」导出备份；
        跑完可在控制台执行 EATG.devSeed.count() 查看各表条数。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var D = (EATG.devSeed = EATG.devSeed || {});

  var IP = ['MyGO', 'BangDream', '无期迷途', '其他IP'];
  var TYPES = ['吧唧', '立牌', '亚克力', '毛绒', '色纸', '徽章', '挂件', '专辑', '其他'];
  var STATUSES = ['deposit_pre', 'full_pre', 'shipping', 'on_hand', 'sold_out'];
  var CHANNELS = ['官网', '淘宝', '拼多多', '闲鱼', '线下店'];

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function rnd(a) { return Math.floor(Math.random() * a); }
  function rndItem(arr) { return arr[rnd(arr.length)]; }
  function maxId(list) { return list.reduce(function (m, v) { return Math.max(m, num(v.id)); }, 0); }

  function chunkPut(store, list, chunk) {
    chunk = chunk || 200;
    var i = 0;
    function next() {
      if (i >= list.length) return Promise.resolve();
      var batch = list.slice(i, i + chunk);
      i += chunk;
      return Promise.all(batch.map(function (v) { return EATG.storage.put(store, v); })).then(next);
    }
    return next();
  }

  D.count = function () {
    return EATG.storage.initDB().then(function () {
      return Promise.all([
        EATG.storage.getAll('goods'),
        EATG.storage.getAll('purchase_items'),
        EATG.storage.getAll('sale_items')
      ]).then(function (r) {
        console.log('[EATG-dev] 当前条数 goods=' + r[0].length + ' purchase_items=' + r[1].length + ' sale_items=' + r[2].length);
        return { goods: r[0].length, purchase_items: r[1].length, sale_items: r[2].length };
      });
    });
  };

  D.run = function (opts) {
    opts = opts || {};
    var G = num(opts.goods) || 5000;
    var I = num(opts.items) || 20000;
    if (!global.confirm('将写入约 ' + G + ' 个谷子款、' + I + ' 条购入记录（测试数据）。建议先到「数据管理」导出备份。继续？')) {
      return Promise.resolve('cancelled');
    }
    var t0 = Date.now();
    return EATG.storage.initDB().then(function () {
      return Promise.all([EATG.storage.getAll('goods'), EATG.storage.getAll('purchase_items')]).then(function (res) {
        var cur = Math.max(maxId(res[0]), maxId(res[1]));
        var goods = [], items = [];
        for (var g = 0; g < G; g++) {
          cur = cur + 1;
          var id = cur;
          var status = STATUSES[rnd(STATUSES.length)];
          goods.push({
            id: id,
            name: '压测谷子' + id,
            ip: rndItem(IP),
            goods_type: rndItem(TYPES),
            status: status,
            favorite: false,
            created_at: new Date().toISOString(),
            note: 'dev_seed'
          });
          var per = 1 + rnd(4);
          for (var k = 0; k < per; k++) {
            cur = cur + 1;
            items.push({
              id: cur,
              goods_id: id,
              status: status,
              price_status: rnd(3) === 0 ? 'unknown' : (rnd(2) ? 'filled' : 'estimated'),
              unit_price: 500 + rnd(20000),
              currency: 'CNY',
              quantity: 1,
              shipping_share: 0,
              sold_quantity: 0,
              channel: rndItem(CHANNELS),
              created_at: new Date().toISOString()
            });
          }
        }
        return chunkPut('goods', goods).then(function () {
          return chunkPut('purchase_items', items);
        }).then(function () {
          var ms = Date.now() - t0;
          console.log('[EATG-dev] 造数完成 goods=' + G + ' purchase_items=' + items.length + ' 耗时 ' + ms + 'ms');
          global.alert('完成：' + G + ' 款 / ' + items.length + ' 条购入，耗时 ' + ms + 'ms。返回收藏库体验滚动/筛选/搜索。');
        });
      });
    });
  };

})(window);
