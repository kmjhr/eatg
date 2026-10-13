/* ==========================================================================
   一咕（EATG）· 全局提醒（js/reminder.js）
   三类提醒：① 开订（news.preorder_time）② 出荷（news.release_time）
             ③ 补款截止（purchase_items.status=deposit_pre 的 payment_deadline）
   规则：设置页 reminder 开关；免打扰时段不弹；仅 Notification 权限已授予时弹出；
        tag 去重（同一条记录只弹一次新通知覆盖旧通知）。
   调用：app.js 启动 initDB 成功后执行 EATG.reminder.checkAll()。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var R = (EATG.reminder = EATG.reminder || {});

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function toMin(hhmm) {
    if (!hhmm) return 0;
    var p = String(hhmm).split(':');
    return num(p[0]) * 60 + num(p[1] || 0);
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayDiff(a, b) {
    var da = new Date(a + 'T00:00:00');
    var db = new Date(b + 'T00:00:00');
    if (isNaN(da.getTime()) || isNaN(db.getTime())) return NaN;
    return Math.round((db - da) / 86400000);
  }
  function inQuiet(rem, now) {
    var hm = now.getHours() * 60 + now.getMinutes();
    var qs = toMin(rem.quiet_start), qe = toMin(rem.quiet_end);
    if (qs === qe) return false;
    return qs < qe ? (hm >= qs && hm < qe) : (hm >= qs || hm < qe);
  }
  function fire(title, body, tag) {
    try {
      if (global.Notification && Notification.permission === 'granted') {
        new Notification(title, { body: body, tag: tag });
      }
    } catch (e) { /* 静默：通知失败不影响主流程 */ }
  }

  /** 检查并触发三类提醒；返回 Promise<boolean>（是否弹出了提醒） */
  R.checkAll = function () {
    return EATG.storage.getSetting('reminder').then(function (rem) {
      rem = rem || { preorder_lead: 1, deadline_lead: 1, quiet_start: '22:00', quiet_end: '08:00', enabled: true };
      if (!rem.enabled) return false;
      var now = new Date();
      if (inQuiet(rem, now)) return false;
      var today = todayStr();
      var preLead = num(rem.preorder_lead) || 1;
      var dlLead = num(rem.deadline_lead) || 1;

      return Promise.all([
        EATG.storage.getAll('news'),
        EATG.storage.getAll('purchase_items'),
        EATG.storage.getAll('goods')
      ]).then(function (res) {
        var news = res[0] || [], purchases = res[1] || [], goods = res[2] || [];
        var goodsMap = {};
        goods.forEach(function (g) { goodsMap[g.id] = g; });
        var fired = false;

        // ① 开订 / ② 出荷
        news.forEach(function (n) {
          if (n.status === 'ordered' || n.status === 'ignored') return;
          var t = n.preorder_time || n.release_time;
          if (!t) return;
          var diff = dayDiff(today, t);
          if (!(diff >= 0 && diff <= preLead)) return;
          fire('一咕提醒 · ' + (n.preorder_time ? '开订' : '出荷'), n.title, 'eatg-news-' + n.id);
          fired = true;
        });

        // ③ 补款截止（定尾预售且未关闭提醒）
        purchases.forEach(function (p) {
          if (p.status !== 'deposit_pre') return;
          if (p.remind_enabled === false) return;
          if (!p.payment_deadline) return;
          var diff = dayDiff(today, p.payment_deadline);
          if (!(diff >= 0 && diff <= dlLead)) return;
          var g = goodsMap[p.goods_id];
          fire('一咕提醒 · 补款截止', (g && g.name) || ('谷子#' + p.goods_id) + ' 补款截止 ' + p.payment_deadline, 'eatg-pay-' + p.id);
          fired = true;
        });

        return fired;
      });
    }).catch(function () { return false; });
  };

})(window);
