/* ==========================================================================
   一咕（EATG）· 数据管理页（js/pages/data.js）
   实现：《页面线框与UI规范》P21 + 《数据字典》§6 + 《业务规则》§11
   路由：#/data
   内容：1 导出区：五维度多选 + 导出JSON / 导出CSV（金额为分整数，表头注明单位）
        2 备份区：完整备份（含图片）/ 最近备份时间 / 自动备份提醒开关
        3 恢复区：选择备份文件 / 导入；恢复前自动备份当前数据（.pre-restore-<时间戳>）
        4 说明：数据仅存本机
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var U = EATG.utils;
  var UI = EATG.ui;

  EATG.pages = EATG.pages || {};

  var state = null;
  var dom = {};
  var offs = [];

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); offs.push([el, ev, fn, opt]); }
  function clearOffs() { offs.forEach(function (t) { t[0].removeEventListener(t[1], t[2], t[3]); }); offs = []; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function esc(s) { return UI.esc(s == null ? '' : String(s)); }

  // 五维度导出集合（《数据字典》§6）
  var EXPORT_DIMS = [
    { key: 'goods',          label: '谷子款' },
    { key: 'purchase_items', label: '购入记录' },
    { key: 'orders',         label: '订单' },
    { key: 'sale_items',     label: '卖出记录' },
    { key: 'sale_orders',    label: '卖出订单' }
  ];

  // 完整备份集合（所有 store）
  var BACKUP_STORES = ['goods', 'purchase_items', 'orders', 'sale_items', 'sale_orders',
    'characters', 'gallery_items', 'price_records', 'news', 'sources', 'settings', 'enums'];

  // 各集合金额字段（用于 CSV 表头注明"分"）
  var MONEY_FIELDS = {
    goods: [],
    purchase_items: ['unit_price', 'postage'],
    orders: ['total_amount', 'postage'],
    sale_items: ['sale_price', 'postage'],
    sale_orders: ['total_amount', 'postage']
  };

  function resetState() {
    state = {
      destroyed: false,
      dims: {},
      last_backup_at: null,
      auto_backup_remind: S.SETTINGS_DEFAULTS.auto_backup_remind
    };
    EXPORT_DIMS.forEach(function (d) { state.dims[d.key] = true; });
  }

  function load() {
    return Promise.all([
      S.getSetting('last_backup_at'),
      S.getSetting('auto_backup_remind')
    ]).then(function (r) {
      state.last_backup_at = r[0] || null;
      state.auto_backup_remind = r[1] || S.SETTINGS_DEFAULTS.auto_backup_remind;
    });
  }

  function fmtTS(ts) {
    if (!ts) return '尚未备份';
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
      ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fileStamp() {
    var d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
      '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  function getSelectedDims() {
    return EXPORT_DIMS.filter(function (d) { return state.dims[d.key]; }).map(function (d) { return d.key; });
  }

  // ---- 导出 ----
  function buildExportData(keys) {
    return Promise.all(keys.map(function (k) { return S.getAll(k); })).then(function (rows) {
      var data = {};
      keys.forEach(function (k, i) { data[k] = rows[i] || []; });
      return data;
    });
  }

  function exportJSON() {
    var keys = getSelectedDims();
    if (!keys.length) { UI.toast('请至少选择一个维度', 'info'); return; }
    buildExportData(keys).then(function (data) {
      var obj = { app: 'eatg', version: 1, exported_at: new Date().toISOString(), data: data };
      download('eatg-export-' + fileStamp() + '.json', JSON.stringify(obj, null, 2), 'application/json');
      UI.toast('JSON 已导出（' + keys.length + ' 个维度）', 'success');
    }).catch(function (err) { UI.toast('导出失败：' + err.message, 'error'); });
  }

  // CSV：列名与字段名一致，金额为分整数，表头注明单位
  function rowsToCSV(rows, moneyFields) {
    if (!rows || !rows.length) return '';
    var cols = Object.keys(rows[0]);
    moneyFields = moneyFields || [];
    var header = cols.map(function (c) {
      return moneyFields.indexOf(c) >= 0 ? (c + '（分）') : c;
    });
    var lines = [header.map(csvCell).join(',')];
    rows.forEach(function (r) {
      lines.push(cols.map(function (c) { return csvCell(r[c]); }).join(','));
    });
    return lines.join('\r\n');
  }

  function csvCell(v) {
    if (v == null) return '';
    if (typeof v === 'object') v = JSON.stringify(v);
    var s = String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCSV() {
    var keys = getSelectedDims();
    if (!keys.length) { UI.toast('请至少选择一个维度', 'info'); return; }
    buildExportData(keys).then(function (data) {
      var parts = [];
      keys.forEach(function (k) {
        var csv = rowsToCSV(data[k], MONEY_FIELDS[k] || []);
        if (csv) {
          parts.push('# === ' + k + ' ===');
          parts.push(csv);
          parts.push('');
        }
      });
      if (!parts.length) { UI.toast('所选维度无数据', 'info'); return; }
      download('eatg-export-' + fileStamp() + '.csv', parts.join('\r\n'), 'text/csv;charset=utf-8');
      UI.toast('CSV 已导出（' + keys.length + ' 个维度）', 'success');
    }).catch(function (err) { UI.toast('导出失败：' + err.message, 'error'); });
  }

  // ---- 备份 ----
  function fullBackup() {
    return Promise.all(BACKUP_STORES.map(function (k) { return S.getAll(k); })).then(function (rows) {
      var data = {};
      BACKUP_STORES.forEach(function (k, i) { data[k] = rows[i] || []; });
      return { app: 'eatg', version: 1, exported_at: new Date().toISOString(), data: data };
    });
  }

  function doBackup() {
    return fullBackup().then(function (obj) {
      download('eatg-backup-' + fileStamp() + '.json', JSON.stringify(obj, null, 2), 'application/json');
      var ts = Date.now();
      state.last_backup_at = ts;
      return S.setSetting('last_backup_at', ts).then(function () {
        refreshBackupInfo();
        UI.toast('完整备份已导出（含图片）', 'success');
      });
    }).catch(function (err) { UI.toast('备份失败：' + err.message, 'error'); });
  }

  function refreshBackupInfo() {
    var el = document.getElementById('dm-backup-time');
    if (el) el.textContent = fmtTS(state.last_backup_at);
  }

  function toggleAutoBackup() {
    var cb = document.getElementById('dm-auto-backup');
    var enabled = !!(cb && cb.checked);
    var ab = state.auto_backup_remind || {};
    ab.enabled = enabled;
    S.setSetting('auto_backup_remind', ab).then(function () {
      state.auto_backup_remind = ab;
      UI.toast(enabled ? '已开启自动备份提醒' : '已关闭自动备份提醒', 'success');
    }).catch(function (err) { UI.toast('保存失败：' + err.message, 'error'); });
  }

  // ---- 恢复 ----
  function triggerRestoreFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    on(input, 'change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var obj = JSON.parse(reader.result);
          validateAndRestore(obj, file.name);
        } catch (e) {
          UI.toast('文件解析失败：' + e.message, 'error');
        }
      };
      reader.onerror = function () { UI.toast('读取文件失败', 'error'); };
      reader.readAsText(file);
    });
    input.click();
  }

  function validateAndRestore(obj, filename) {
    // 校验 app / version（《数据字典》§6）
    if (!obj || obj.app !== 'eatg') {
      UI.toast('文件格式错误：app 不是 eatg', 'error'); return;
    }
    if (!isFinite(num(obj.version)) || num(obj.version) > 1) {
      UI.toast('文件版本过高，无法恢复', 'error'); return;
    }
    if (!obj.data || typeof obj.data !== 'object') {
      UI.toast('文件缺少 data 字段', 'error'); return;
    }

    var data = obj.data;
    var storeKeys = Object.keys(data).filter(function (k) {
      return BACKUP_STORES.indexOf(k) >= 0 && Array.isArray(data[k]);
    });

    UI.confirmDialog({
      title: '恢复备份',
      message: '将覆盖当前数据（共 ' + storeKeys.length + ' 个集合）。\n恢复前会自动备份当前数据。确认继续？',
      confirmText: '确认恢复',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      // 恢复前自动备份当前数据（.pre-restore-<时间戳>）
      fullBackup().then(function (cur) {
        download('eatg-pre-restore-' + fileStamp() + '.json', JSON.stringify(cur, null, 2), 'application/json');
        return clearAndPut(storeKeys, data);
      }).then(function () {
        state.last_backup_at = Date.now();
        refreshBackupInfo();
        UI.toast('恢复成功：' + filename, 'success');
      }).catch(function (err) { UI.toast('恢复失败：' + err.message, 'error'); });
    });
  }

  // 清空指定集合并写入新数据（事务内完成）
  function clearAndPut(storeKeys, data) {
    // 先获取各集合所有 key 并删除
    return Promise.all(storeKeys.map(function (k) { return S.getAll(k); })).then(function (rowsList) {
      var delOps = [];
      storeKeys.forEach(function (k, i) {
        (rowsList[i] || []).forEach(function (row) {
          if (row && row.id != null) delOps.push({ action: 'del', store: k, key: row.id });
        });
      });
      if (delOps.length) return S.bulk(storeKeys, delOps);
    }).then(function () {
      var ops = [];
      storeKeys.forEach(function (k) {
        (data[k] || []).forEach(function (v) {
          ops.push({ action: 'put', store: k, value: v });
        });
      });
      if (!ops.length) return;
      return S.bulk(storeKeys, ops);
    });
  }

  // ---- HTML ----
  function dimCheckboxes() {
    return EXPORT_DIMS.map(function (d) {
      return '<label class="dm-dim"><input type="checkbox" class="dm-dim-cb" data-key="' + esc(d.key) + '" ' +
        (state.dims[d.key] ? 'checked' : '') + '><span>' + esc(d.label) + '</span></label>';
    }).join('');
  }

  function pageHTML() {
    var ab = state.auto_backup_remind || {};
    return '<div class="dm-page">' +
      '<div class="dm-section">' +
        '<div class="dm-section-title">导出数据</div>' +
        '<div class="dm-dims">' + dimCheckboxes() + '</div>' +
        '<div class="dm-actions">' +
          '<button id="dm-export-json" type="button" class="btn btn--primary">导出 JSON</button>' +
          '<button id="dm-export-csv" type="button" class="btn">导出 CSV</button>' +
        '</div>' +
        '<div class="dm-note">CSV 金额字段以「分」为单位导出，表头已注明单位。</div>' +
      '</div>' +

      '<div class="dm-section">' +
        '<div class="dm-section-title">完整备份</div>' +
        '<div class="dm-info-row"><span>最近备份</span><span id="dm-backup-time">' + esc(fmtTS(state.last_backup_at)) + '</span></div>' +
        '<div class="dm-info-row"><span>自动备份提醒</span>' +
          '<label class="switch"><input type="checkbox" id="dm-auto-backup" ' + (ab.enabled ? 'checked' : '') + '><span class="switch-track"></span></label>' +
        '</div>' +
        '<div class="dm-actions">' +
          '<button id="dm-backup" type="button" class="btn btn--primary">完整备份（含图片）</button>' +
        '</div>' +
      '</div>' +

      '<div class="dm-section">' +
        '<div class="dm-section-title">恢复数据</div>' +
        '<div class="dm-actions">' +
          '<button id="dm-restore" type="button" class="btn">选择备份文件并导入</button>' +
        '</div>' +
        '<div class="dm-note">恢复前会自动备份当前数据（.pre-restore-时间戳）。仅支持 app=eatg、version≤1 的备份文件。</div>' +
      '</div>' +

      '<div class="dm-footer">所有数据仅存于本机浏览器，不上传服务器。</div>' +
    '</div>';
  }

  function bind() {
    // 维度勾选
    var cbs = document.querySelectorAll('.dm-dim-cb');
    cbs.forEach(function (cb) {
      on(cb, 'change', function () {
        var k = cb.getAttribute('data-key');
        state.dims[k] = cb.checked;
      });
    });

    on(document.getElementById('dm-export-json'), 'click', exportJSON);
    on(document.getElementById('dm-export-csv'), 'click', exportCSV);
    on(document.getElementById('dm-backup'), 'click', doBackup);
    on(document.getElementById('dm-auto-backup'), 'change', toggleAutoBackup);
    on(document.getElementById('dm-restore'), 'click', triggerRestoreFile);
  }

  function mount(container, ctx) {
    resetState();
    dom = { container: container };
    container.innerHTML = '<div class="loading">加载中…</div>';
    ctx.setTitle('数据管理');
    ctx.setBack(true);
    ctx.setActiveTab('mine');
    ctx.navActions.innerHTML = '';
    return load().then(function () {
      if (state.destroyed) return;
      container.innerHTML = pageHTML();
      bind();
    }).catch(function (err) {
      if (state.destroyed) return;
      console.error('[EATG] 数据管理页加载失败', err);
      UI.toast('加载失败：' + (err && err.message || err), 'error');
    });
  }

  function unmount() {
    if (state) state.destroyed = true;
    clearOffs();
  }

  EATG.pages['data'] = { key: 'data', mount: mount, unmount: unmount };

})(window);
