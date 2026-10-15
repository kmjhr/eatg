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

  // 字段选项管理（enums 中允许用户维护的键；系统枚举不展示）
  var MANAGE_ENUMS = [
    { key: 'ip', label: 'IP' },
    { key: 'goods_type', label: '类型' },
    { key: 'channel', label: '渠道' },
    { key: 'sale_channel', label: '卖出渠道' },
    { key: 'condition', label: '品相' }
  ];

  // 图鉴五大品类（固定顺序，条目显式填写，未填写视为「其他」）
  var CATS = ['吧唧', '纸片', '立牌', '毛绒', '其他'];

  // 快捷词（与谷子编辑页共用 localStorage: eatg_quick_words）
  var QUICK_KEY = 'eatg_quick_words';
  var QW_FIELDS = [
    ['name', '名称'], ['channel', '渠道'], ['ip', 'IP'], ['goods_type', '类型'],
    ['tags', '标签'], ['note', '备注'], ['pnote', '购入备注'], ['unit_price', '本体单价'], ['shipping_share', '邮费分摊']
  ];
  var DEFAULT_QUICK_WORDS = {
    name: ['长崎素世', '吧唧'],
    channel: ['淘宝', '闲鱼', '日拍', '煤炉'],
    ip: [], goods_type: [], tags: [], note: [], pnote: [], unit_price: [], shipping_share: []
  };

  function resetState() {
    state = {
      tab: 'library', // 数据管理内部分区：library 收藏库管理 / gallery 图鉴管理（并列切换）

      destroyed: false,
      dims: {},
      last_backup_at: null,
      auto_backup_remind: S.SETTINGS_DEFAULTS.auto_backup_remind,
      enums: {},
      quickWords: {},
      characters: [],
      galleryItems: []
    };
    EXPORT_DIMS.forEach(function (d) { state.dims[d.key] = true; });
  }

  function load() {
    return Promise.all([
      S.getSetting('last_backup_at'),
      S.getSetting('auto_backup_remind'),
      S.getAll('enums'),
      S.getAll('characters'),
      S.getAll('gallery_items'),
      S.getSetting('galleryCats')
    ]).then(function (r) {
      state.last_backup_at = r[0] || null;
      state.auto_backup_remind = r[1] || S.SETTINGS_DEFAULTS.auto_backup_remind;
      var enumsMap = {};
      (r[2] || []).forEach(function (row) { enumsMap[row.key] = row.values || []; });
      state.enums = enumsMap;
      state.quickWords = loadQuickWordsMerged();
      state.characters = r[3] || [];
      state.galleryItems = r[4] || [];
      state.galleryCats = (Array.isArray(r[5]) && r[5].length) ? r[5] : EATG.DEFAULT_GALLERY_CATS.slice();
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
  // ---- 字段选项 / 快捷词 管理 ----

  function normQW(raw) {
    var map = {};
    function push(field, words) {
      if (!field || !Array.isArray(words)) return;
      var list = words.map(function (w) { return w == null ? '' : String(w).trim(); }).filter(function (w) { return w; });
      if (list.length) map[field] = (map[field] || []).concat(list);
    }
    if (Array.isArray(raw)) raw.forEach(function (it) { if (it) push(it.field, it.words); });
    else if (raw && typeof raw === 'object') Object.keys(raw).forEach(function (k) { push(k, raw[k]); });
    return map;
  }
  function loadQuickWordsMerged() {
    var merged = normQW(DEFAULT_QUICK_WORDS);
    var stored = null;
    try { var s = localStorage.getItem(QUICK_KEY); if (s) stored = JSON.parse(s); } catch (e) { stored = null; }
    var custom = normQW(stored);
    Object.keys(custom).forEach(function (k) {
      var base = merged[k] || [];
      custom[k].forEach(function (w) { if (base.indexOf(w) === -1) base.push(w); });
      merged[k] = base;
    });
    return merged;
  }
  function saveQuickWordsFull() {
    try { localStorage.setItem(QUICK_KEY, JSON.stringify(state.quickWords)); } catch (e) {}
  }

  function enumsHTML() {
    return '<div class="dm-section">' +
      '<div class="dm-section-title">字段选项</div>' +
      '<p class="dm-note">管理下拉选项（IP / 类型 / 渠道 / 卖出渠道 / 品相）。改动只影响之后的录入，已保存的记录不受影响。</p>' +
      MANAGE_ENUMS.map(function (cfg) {
        var vals = state.enums[cfg.key] || [];
        var chips = vals.map(function (v, i) {
          return '<span class="dm-chip">' +
            '<button type="button" class="dm-chip-word" data-act="edit-enum" data-key="' + cfg.key + '" data-i="' + i + '">' + esc(v) + '</button>' +
            '<button type="button" class="dm-chip-x" data-act="del-enum" data-key="' + cfg.key + '" data-i="' + i + '">×</button></span>';
        }).join('');
        return '<div class="dm-group">' +
          '<div class="dm-group-title">' + esc(cfg.label) + '</div>' +
          '<div class="dm-chips">' + (chips || '<span class="muted">暂无选项</span>') + '</div>' +
          '<div class="dm-add-row"><input class="input" id="enum-add-' + cfg.key + '" type="text" autocomplete="off" placeholder="新增' + esc(cfg.label) + '选项">' +
          '<button type="button" class="btn btn--sm" data-act="add-enum" data-key="' + cfg.key + '">添加</button></div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  /** 谷子角色区：谷子详情角色字段选项（gallery===false），与图鉴人物分开管理 */
  function charsHTML() {
    var chars = (state.characters || []).filter(function (c) { return c.gallery === false; });
    var chips = chars.map(function (c, i) {
      return '<span class="dm-chip">' +
        '<button type="button" class="dm-chip-word" data-act="edit-char" data-i="' + i + '">' + esc(c.name) + '</button>' +
        '<button type="button" class="dm-chip-x" data-act="del-char" data-i="' + i + '">×</button></span>';
    }).join('');
    return '<div class="dm-section">' +
      '<div class="dm-section-title">谷子角色</div>' +
      '<p class="dm-note">谷子详情的角色选项（仅谷子侧使用）。删除仅从谷子库移除该选项，不影响图鉴。</p>' +
      '<div class="dm-group">' +
        '<div class="dm-chips">' + (chips || '<span class="muted">暂无谷子角色</span>') + '</div>' +
        '<div class="dm-add-row"><input class="input" id="char-add" type="text" autocomplete="off" placeholder="新增谷子角色名">' +
        '<button type="button" class="btn btn--sm" data-act="add-char">添加</button></div>' +
      '</div>' +
    '</div>';
  }
  function addChar() {
    var input = document.getElementById('char-add');
    var v = input ? input.value.trim() : '';
    if (!v) { UI.toast('请输入角色名', 'error'); return; }
    // 谷子角色查重只限谷子侧（图鉴人物同名不挡）
    if (state.characters.some(function (c) { return c.name === v && c.gallery === false; })) { UI.toast('该谷子角色已存在', 'error'); return; }
    S.add('characters', { name: v, ip: '其他', is_favorite: false, gallery: false }).then(function (id) {
      state.characters.push({ id: Number(id), name: v, ip: '其他', is_favorite: false, gallery: false });
      UI.toast('已添加谷子角色', 'success'); rerender();
    }).catch(function () { UI.toast('保存失败', 'error'); });
  }
  /** 谷子角色删除：仅移除谷子侧选项（谷子中引用它的将不再显示名字），不动图鉴 */
  function delChar(i) {
    var chars = (state.characters || []).filter(function (c) { return c.gallery === false; });
    var c = chars[i];
    if (!c) return;
    UI.confirmDialog({
      title: '删除谷子角色',
      message: '删除谷子角色「' + c.name + '」？谷子中引用该角色的将不再显示名字；图鉴不受影响。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      S.del('characters', c.id).then(function () {
        state.characters = state.characters.filter(function (x) { return x.id !== c.id; });
        UI.toast('已删除', 'success');
        rerender();
      }).catch(function () { UI.toast('删除失败', 'error'); });
    });
  }
  function editChar(i) {
    var c = state.characters[i];
    if (!c) return;
    var ref = UI.sheet({
      title: '编辑角色',
      bodyHTML: '<input class="input" id="char-edit-input" autocomplete="off" value="' + esc(c.name) + '">',
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="ok">保存</button>'
    });
    var input = ref.body.querySelector('#char-edit-input');
    if (input) setTimeout(function () { input.focus(); }, 0);
    if (ref.foot) ref.foot.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act !== 'ok') { ref.close(); return; }
      var v = input ? input.value.trim() : '';
      if (!v) { UI.toast('内容不能为空', 'error'); return; }
      if (state.characters.some(function (x) { return x.id !== c.id && x.name === v; })) { UI.toast('该角色已存在', 'error'); return; }
      c.name = v;
      S.put('characters', c).then(function () { UI.toast('已保存', 'success'); ref.close(); rerender(); })
        .catch(function () { UI.toast('保存失败', 'error'); });
    });
  }

  /** 图鉴角色区：图鉴分类的角色（gallery!==false，含历史/导入角色） */
  function galCharsHTML() {
    var chars = (state.characters || []).filter(function (c) { return c.gallery !== false; });
    var chips = chars.map(function (c, i) {
      return '<span class="dm-chip">' +
        '<button type="button" class="dm-chip-word" data-act="edit-galchar" data-i="' + i + '">' + esc(c.name) + '</button>' +
        '<button type="button" class="dm-chip-x" data-act="del-galchar" data-i="' + i + '">×</button></span>';
    }).join('');
    return '<div class="dm-section">' +
      '<div class="dm-section-title">图鉴人物</div>' +
      '<p class="dm-note">图鉴分类用的角色（如长崎素世）。删除会同时移除该人物的图鉴条目，谷子记录不受影响。</p>' +
      '<div class="dm-group">' +
        '<div class="dm-chips">' + (chips || '<span class="muted">暂无图鉴人物</span>') + '</div>' +
        '<div class="dm-add-row"><input class="input" id="gal-add" type="text" autocomplete="off" placeholder="新增图鉴人物名">' +
        '<button type="button" class="btn btn--sm" data-act="add-galchar">添加</button></div>' +
      '</div>' +
    '</div>';
  }
  function addGalChar() {
    var input = document.getElementById('gal-add');
    var v = input ? input.value.trim() : '';
    if (!v) { UI.toast('请输入角色名', 'error'); return; }
    // 图鉴人物与谷子角色分开管理：同名仅存在谷子角色/已删图鉴时，允许新建图鉴人物
    if (state.characters.some(function (c) { return c.name === v && c.gallery !== false; })) { UI.toast('该图鉴人物已存在', 'error'); return; }
    S.add('characters', { name: v, ip: '其他', is_favorite: false, gallery: true }).then(function (id) {
      state.characters.push({ id: Number(id), name: v, ip: '其他', is_favorite: false, gallery: true });
      UI.toast('已添加图鉴人物', 'success'); rerender();
    }).catch(function () { UI.toast('保存失败', 'error'); });
  }
  function editGalChar(i) {
    var chars = (state.characters || []).filter(function (c) { return c.gallery !== false; });
    var c = chars[i];
    if (!c) return;
    var ref = UI.sheet({
      title: '编辑图鉴人物',
      bodyHTML: '<div class="field"><div class="field-head"><label class="field-label">角色名</label></div>' +
        '<input class="input" id="gal-edit-name" autocomplete="off" value="' + esc(c.name) + '"></div>' +
        '<div class="field"><div class="field-head"><label class="field-label">所属 IP</label></div>' +
        '<input class="input" id="gal-edit-ip" autocomplete="off" value="' + esc(c.ip || '') + '"></div>',
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="ok">保存</button>'
    });
    var nameInput = ref.body.querySelector('#gal-edit-name');
    if (nameInput) setTimeout(function () { nameInput.focus(); }, 0);
    if (ref.foot) ref.foot.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act !== 'ok') { ref.close(); return; }
      var name = nameInput ? nameInput.value.trim() : '';
      var ip = (ref.body.querySelector('#gal-edit-ip') || {}).value || '';
      if (!name) { UI.toast('内容不能为空', 'error'); return; }
      if (state.characters.some(function (x) { return x.id !== c.id && x.name === name && x.gallery !== false; })) { UI.toast('该图鉴人物已存在', 'error'); return; }
      c.name = name;
      c.ip = ip.trim();
      S.put('characters', c).then(function () { UI.toast('已保存', 'success'); ref.close(); rerender(); })
        .catch(function () { UI.toast('保存失败', 'error'); });
    });
  }
  /** 图鉴人物删除：从图鉴移除（gallery=false）+ 删除其图鉴条目；谷子记录保留 */
  function delGalChar(i) {
    var chars = (state.characters || []).filter(function (c) { return c.gallery !== false; });
    var c = chars[i];
    if (!c) return;
    UI.confirmDialog({
      title: '删除图鉴人物',
      message: '删除「' + c.name + '」？将移除该人物的图鉴分类和全部图鉴条目；谷子库记录不受影响。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var removeItems = function () {
        return S.getAll('gallery_items').then(function (items) {
          var dels = (items || []).filter(function (it) { return it.character_id === c.id; });
          var p = Promise.resolve();
          dels.forEach(function (it) { p = p.then(function () { return S.del('gallery_items', it.id); }); });
          return p;
        });
      };
      return S.getAll('goods').then(function (goods) {
        var used = (goods || []).some(function (g) { return (g.character_ids || []).indexOf(Number(c.id)) !== -1; });
        if (!used) {
          // 无谷子引用：真删角色记录，重建同名图鉴人物时无冲突、无重复
          return S.del('characters', c.id).then(function () {
            state.characters = state.characters.filter(function (x) { return x.id !== c.id; });
            return removeItems();
          });
        }
        c.gallery = false;
        return S.put('characters', c).then(removeItems);
      }).then(function () {
        UI.toast('已删除「' + c.name + '」（谷子记录保留）', 'success');
        rerender();
      }).catch(function () { UI.toast('删除失败', 'error'); });
    });
  }

  /** 品类选项区：管理图鉴品类的选项本身（可增、可删、可编辑），默认五大类；与「图鉴人物」同款 chip 格式 */
  function catMgrHTML() {
    var cats = state.galleryCats.length ? state.galleryCats : EATG.DEFAULT_GALLERY_CATS;
    var chips = cats.map(function (c, i) {
      return '<span class="dm-chip">' +
        '<button type="button" class="dm-chip-word" data-act="edit-cat" data-i="' + i + '">' + esc(c) + '</button>' +
        '<button type="button" class="dm-chip-x" data-act="del-cat" data-i="' + i + '">×</button></span>';
    }).join('');
    return '<div class="dm-section">' +
      '<div class="dm-section-title">品类选项</div>' +
      '<p class="dm-note">图鉴条目的品类选项（默认：吧唧/纸片/立牌/毛绒/其他），可新增、编辑、删除；删除后该品类下的条目归入「其他」。未填写品类的条目显示为「其他」。</p>' +
      '<div class="dm-group">' +
        '<div class="dm-chips">' + (chips || '<span class="muted">暂无品类，请新增</span>') + '</div>' +
        '<div class="dm-add-row"><input class="input" id="cat-add" type="text" autocomplete="off" placeholder="新增品类，如：徽章">' +
        '<button type="button" class="btn btn--sm" data-act="add-cat">添加</button></div>' +
      '</div>' +
    '</div>';
  }

  /** 读取品类选项（当前 state.galleryCats，空则默认） */
  function currentCats() {
    return state.galleryCats.length ? state.galleryCats : EATG.DEFAULT_GALLERY_CATS.slice();
  }

  function addCat() {
    var input = document.getElementById('cat-add');
    var v = input ? input.value.trim() : '';
    if (!v) { UI.toast('请输入品类名称', 'error'); return; }
    var cats = currentCats();
    if (cats.indexOf(v) >= 0) { UI.toast('该品类已存在', 'error'); return; }
    cats.push(v);
    state.galleryCats = cats;
    S.setSetting('galleryCats', cats).then(function () { UI.toast('已添加品类', 'success'); rerender(); })
      .catch(function () { UI.toast('保存失败', 'error'); });
  }

  function editCat(i) {
    var cats = currentCats();
    if (i < 0 || i >= cats.length) return;
    var old = cats[i];
    var ref = UI.sheet({
      title: '编辑品类',
      bodyHTML: '<input class="input" id="cat-edit-input" autocomplete="off" value="' + esc(old) + '">',
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="ok">保存</button>'
    });
    var input = ref.body.querySelector('#cat-edit-input');
    if (input) setTimeout(function () { input.focus(); }, 0);
    if (ref.foot) ref.foot.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'cancel') { ref.close(); return; }
      if (act.getAttribute('data-act') === 'ok') {
        var name = ref.body.querySelector('#cat-edit-input');
        var v = name ? name.value.trim() : '';
        if (!v) { UI.toast('品类名不能为空', 'error'); return; }
        if (v === old) { ref.close(); return; }
        var c = cats.slice();
        if (c.indexOf(v) >= 0) { UI.toast('该品类已存在', 'error'); return; }
        c[i] = v;
        // 同步更新该品类下所有图鉴条目的 category（保持数据一致）
        var items = state.galleryItems || [];
        var updated = [];
        items.forEach(function (it) {
          if (String(it.category || '') === old) { it.category = v; updated.push(it); }
        });
        state.galleryCats = c;
        var ops = updated.map(function (it) { return { action: 'put', store: 'gallery_items', value: it }; });
        var chain = S.setSetting('galleryCats', c);
        if (ops.length) chain = chain.then(function () { return S.bulk(['gallery_items'], ops); });
        chain.then(function () { ref.close(); UI.toast('品类已改名，' + updated.length + ' 条条目已同步', 'success'); rerender(); })
          .catch(function () { UI.toast('保存失败', 'error'); });
      }
    });
  }

  function delCat(i) {
    var cats = currentCats();
    if (i < 0 || i >= cats.length) return;
    var name = cats[i];
    UI.confirmDialog({
      title: '删除品类',
      message: '删除品类「' + name + '」？该品类下的图鉴条目将归入「其他」。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var c = cats.slice();
      c.splice(i, 1);
      if (!c.length) c = EATG.DEFAULT_GALLERY_CATS.slice();
      // 该品类下条目 category 清空 → 显示归「其他」
      var items = state.galleryItems || [];
      var updated = [];
      items.forEach(function (it) {
        if (String(it.category || '') === name) { it.category = ''; updated.push(it); }
      });
      state.galleryCats = c;
      var ops = updated.map(function (it) { return { action: 'put', store: 'gallery_items', value: it }; });
      var chain = S.setSetting('galleryCats', c);
      if (ops.length) chain = chain.then(function () { return S.bulk(['gallery_items'], ops); });
      chain.then(function () { UI.toast('已删除品类，' + updated.length + ' 条条目已归入其他', 'success'); rerender(); })
        .catch(function () { UI.toast('保存失败', 'error'); });
    });
  }

  function quickHTML() {
    return '<div class="dm-section">' +
      '<div class="dm-section-title">快捷词</div>' +
      '<p class="dm-note">谷子录入时「快捷词」面板用到的词，按字段管理，改动即时生效。</p>' +
      QW_FIELDS.map(function (pair) {
        var field = pair[0], label = pair[1];
        var vals = state.quickWords[field] || [];
        var chips = vals.map(function (v, i) {
          return '<span class="dm-chip">' +
            '<button type="button" class="dm-chip-word" data-act="edit-qw" data-field="' + field + '" data-i="' + i + '">' + esc(v) + '</button>' +
            '<button type="button" class="dm-chip-x" data-act="del-qw" data-field="' + field + '" data-i="' + i + '">×</button></span>';
        }).join('');
        return '<div class="dm-group">' +
          '<div class="dm-group-title">' + esc(label) + '</div>' +
          '<div class="dm-chips">' + (chips || '<span class="muted">暂无快捷词</span>') + '</div>' +
          '<div class="dm-add-row"><input class="input" id="qw-add-' + field + '" type="text" autocomplete="off" placeholder="新增快捷词">' +
          '<button type="button" class="btn btn--sm" data-act="add-qw" data-field="' + field + '">添加</button></div>' +
        '</div>';
      }).join('') +
    '</div>';
  }

  function rerender() {
    if (!dom.container || state.destroyed) return;
    dom.container.innerHTML = pageHTML();
    bind();
  }

  function addEnum(key) {
    var input = document.getElementById('enum-add-' + key);
    var v = input ? input.value.trim() : '';
    if (!v) { UI.toast('请输入选项内容', 'error'); return; }
    var arr = state.enums[key] || (state.enums[key] = []);
    if (arr.indexOf(v) !== -1) { UI.toast('该选项已存在', 'error'); return; }
    arr.push(v);
    S.put('enums', { key: key, values: arr }).then(function () { UI.toast('已添加', 'success'); rerender(); })
      .catch(function () { UI.toast('保存失败', 'error'); });
  }
  function delEnum(key, i) {
    var arr = state.enums[key] || [];
    if (i < 0 || i >= arr.length) return;
    var v = arr[i];
    UI.confirmDialog({
      title: '删除选项',
      message: '删除选项「' + v + '」？只影响之后的下拉列表，已保存的记录保留原值。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      arr.splice(i, 1);
      S.put('enums', { key: key, values: arr }).then(function () { UI.toast('已删除', 'success'); rerender(); })
        .catch(function () { UI.toast('保存失败', 'error'); });
    });
  }
  function editEnum(key, i) {
    var arr = state.enums[key] || [];
    if (i < 0 || i >= arr.length) return;
    var old = arr[i];
    var ref = UI.sheet({
      title: '编辑选项',
      bodyHTML: '<input class="input" id="enum-edit-input" autocomplete="off" value="' + esc(old) + '">',
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="ok">保存</button>'
    });
    var input = ref.body.querySelector('#enum-edit-input');
    if (input) setTimeout(function () { input.focus(); }, 0);
    if (ref.foot) ref.foot.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act !== 'ok') { ref.close(); return; }
      var v = input ? input.value.trim() : '';
      if (!v) { UI.toast('内容不能为空', 'error'); return; }
      if (arr.indexOf(v) !== -1 && v !== old) { UI.toast('该选项已存在', 'error'); return; }
      arr[i] = v;
      S.put('enums', { key: key, values: arr }).then(function () { UI.toast('已保存', 'success'); ref.close(); rerender(); })
        .catch(function () { UI.toast('保存失败', 'error'); });
    });
  }

  function addQW(field) {
    var input = document.getElementById('qw-add-' + field);
    var v = input ? input.value.trim() : '';
    if (!v) { UI.toast('请输入快捷词', 'error'); return; }
    var arr = state.quickWords[field] || (state.quickWords[field] = []);
    if (arr.indexOf(v) !== -1) { UI.toast('该快捷词已存在', 'error'); return; }
    arr.push(v);
    saveQuickWordsFull();
    UI.toast('已添加', 'success');
    rerender();
  }
  function delQW(field, i) {
    var arr = state.quickWords[field] || [];
    if (i < 0 || i >= arr.length) return;
    arr.splice(i, 1);
    saveQuickWordsFull();
    UI.toast('已删除', 'success');
    rerender();
  }
  function editQW(field, i) {
    var arr = state.quickWords[field] || [];
    if (i < 0 || i >= arr.length) return;
    var old = arr[i];
    var ref = UI.sheet({
      title: '编辑快捷词',
      bodyHTML: '<input class="input" id="qw-edit-input" autocomplete="off" value="' + esc(old) + '">',
      footerHTML: '<button type="button" class="btn btn--secondary" data-act="cancel">取消</button>' +
        '<button type="button" class="btn btn--primary" data-act="ok">保存</button>'
    });
    var input = ref.body.querySelector('#qw-edit-input');
    if (input) setTimeout(function () { input.focus(); }, 0);
    if (ref.foot) ref.foot.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act !== 'ok') { ref.close(); return; }
      var v = input ? input.value.trim() : '';
      if (!v) { UI.toast('内容不能为空', 'error'); return; }
      if (arr.indexOf(v) !== -1 && v !== old) { UI.toast('该快捷词已存在', 'error'); return; }
      arr[i] = v;
      saveQuickWordsFull();
      UI.toast('已保存', 'success');
      ref.close();
      rerender();
    });
  }

  function manageClick(e) {
    var b = e.target.closest('[data-act]');
    if (!b) return;
    var a = b.dataset.act;
    if (a === 'add-enum') { addEnum(b.dataset.key); return; }
    if (a === 'del-enum') { delEnum(b.dataset.key, Number(b.dataset.i)); return; }
    if (a === 'edit-enum') { editEnum(b.dataset.key, Number(b.dataset.i)); return; }
    if (a === 'add-qw') { addQW(b.dataset.field); return; }
    if (a === 'del-qw') { delQW(b.dataset.field, Number(b.dataset.i)); return; }
    if (a === 'edit-qw') { editQW(b.dataset.field, Number(b.dataset.i)); return; }
    if (a === 'add-char') { addChar(); return; }
    if (a === 'del-char') { delChar(Number(b.dataset.i)); return; }
    if (a === 'edit-char') { editChar(Number(b.dataset.i)); return; }
    if (a === 'add-galchar') { addGalChar(); return; }
    if (a === 'del-galchar') { delGalChar(Number(b.dataset.i)); return; }
    if (a === 'edit-galchar') { editGalChar(Number(b.dataset.i)); return; }
    if (a === 'add-cat') { addCat(); return; }
    if (a === 'edit-cat') { editCat(Number(b.dataset.i)); return; }
    if (a === 'del-cat') { delCat(Number(b.dataset.i)); return; }
  }

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

      '<div class="dm-tabs">' +
        '<div class="seg" style="width:100%">' +
          '<button type="button" class="seg-btn' + (state.tab === 'library' ? ' is-active' : '') + '" data-tab="library">收藏库管理</button>' +
          '<button type="button" class="seg-btn' + (state.tab === 'gallery' ? ' is-active' : '') + '" data-tab="gallery">图鉴管理</button>' +
        '</div>' +
      '</div>' +

      (state.tab === 'gallery'
        ? '<div class="dm-block-title">图鉴 · 图鉴管理</div>' + galCharsHTML() + catMgrHTML()
        : '<div class="dm-block-title">收藏库 · 谷子管理</div>' + enumsHTML() + charsHTML() + quickHTML()) +

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
    var tabs = document.querySelectorAll('.seg-btn[data-tab]');
    tabs.forEach(function (btn) {
      on(btn, 'click', function () {
        var t = btn.getAttribute('data-tab');
        if (t && t !== state.tab) { state.tab = t; rerender(); }
      });
    });
    if (!dom.manageBound) {
      dom.manageBound = true;
      on(dom.container, 'click', manageClick);
    }
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
