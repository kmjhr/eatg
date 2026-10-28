/* ==========================================================================
   一咕（EATG）· 数据层封装（js/storage.js）
   实现：《详细开发指南》第1步 +《数据字典与存储规范》§2 / §5
   建库：eatg_db（版本1），12 个 objectStore 及索引；enums 预置值；
        settings 默认键；种子角色（长崎素世 + MyGO 其余4人）。
   接口：initDB / add / put / get / getAll / del / query / queryRange /
        bulk / count（全部 Promise 化）+ 便捷 getSetting / setSetting。
   约束：所有页面禁止直接调用 indexedDB.open，一律走本模块。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});

  var DB_NAME = 'eatg_db';
  var DB_VERSION = 1;

  // ---- 12 个 objectStore 定义（严格按《数据字典》§2） ----
  var STORES = [
    { name: 'goods',          keyPath: 'id',  autoIncrement: true,  indexes: ['ip', 'goods_type', 'name'] },
    { name: 'purchase_items', keyPath: 'id',  autoIncrement: true,  indexes: ['goods_id', 'status', 'price_status', 'order_id'] },
    { name: 'orders',         keyPath: 'id',  autoIncrement: true,  indexes: ['order_date', 'channel'] },
    { name: 'sale_items',     keyPath: 'id',  autoIncrement: true,  indexes: ['goods_id', 'purchase_item_id', 'sale_order_id'] },
    { name: 'sale_orders',    keyPath: 'id',  autoIncrement: true,  indexes: ['sale_date', 'channel'] },
    { name: 'characters',     keyPath: 'id',  autoIncrement: true,  indexes: [] },
    { name: 'gallery_items',  keyPath: 'id',  autoIncrement: true,  indexes: ['character_id'] },
    { name: 'price_records',  keyPath: 'id',  autoIncrement: true,  indexes: ['goods_id', 'record_date'] },
    { name: 'news',           keyPath: 'id',  autoIncrement: true,  indexes: ['source_id', 'is_read', 'status'] },
    { name: 'sources',        keyPath: 'id',  autoIncrement: true,  indexes: [] },
    { name: 'settings',       keyPath: 'key', autoIncrement: false, indexes: [] },
    { name: 'enums',          keyPath: 'key', autoIncrement: false, indexes: [] }
  ];

  // 各 store 的时间戳字段（按字典 §2 实际存在情况，自动补 created_at / updated_at）
  var TIME_FIELDS = {
    goods:          { created: true,  updated: true },
    purchase_items: { created: true,  updated: true },
    orders:         { created: true,  updated: true },
    sale_items:     { created: true,  updated: true },
    sale_orders:    { created: true,  updated: true },
    characters:     { created: false, updated: false },
    gallery_items:  { created: false, updated: false },
    price_records:  { created: true,  updated: false },
    news:           { created: true,  updated: false },
    sources:        { created: false, updated: false },
    settings:       { created: false, updated: false },
    enums:          { created: false, updated: false }
  };

  // ---- enums 预置值（《数据字典》§2.12） ----
  var ENUMS_PRESET = {
    ip:           ['MyGO', '邦邦', '无期迷途', '其他'],
    goods_type:   ['徽章（吧唧）', '立牌', '亚克力挂件', '色纸', '拍立得', '卡片', '文件夹', '娃娃', '其他'],
    channel:      ['淘宝', '闲鱼', '煤炉', '日拍', '官方通贩', '实体店', '其他'],
    sale_channel: ['闲鱼', '煤炉', '日拍', '实体店', '转出给他人', '其他'],
    condition:    ['全新', '未拆', '拆摆', '瑕', '其他'],
    goods_status: ['deposit_pre', 'full_pre', 'shipping', 'on_hand', 'sold_out'],
    price_status: ['filled', 'unknown', 'estimated'],
    split_mode:   ['per_item', 'by_amount', 'manual', 'none']
  };

  // ---- settings 内置默认键（《数据字典》§2.11；步1点名 default_currency / exchange_rate / image_quality） ----
  var SETTINGS_DEFAULTS = {
    default_currency: 'CNY',
    theme: 'auto',
    exchange_rate: { rate: 0.05, updated_at: null, source: 'manual' },
    image_quality: 0.8,
    reminder: { preorder_lead: 1, deadline_lead: 1, quiet_start: '22:00', quiet_end: '08:00', enabled: true },
    auto_backup_remind: { enabled: false, period: 'weekly' },
    vision_api: { url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', key: '', model: 'glm-4.6v-flash' },
    last_backup_at: null,
    custom_options: { ips: [], goods_types: [], channels: [], sale_channels: [], conditions: [] }
  };

  // ---- 种子角色：长崎素世（自推）+ MyGO 其余4人（对《指南》步1.4） ----
  var CHARACTER_SEED = [
    { name: '长崎素世', ip: 'MyGO', is_favorite: true },
    { name: '高松灯',   ip: 'MyGO', is_favorite: false },
    { name: '千早爱音', ip: 'MyGO', is_favorite: false },
    { name: '要乐奈',   ip: 'MyGO', is_favorite: false },
    { name: '椎名立希', ip: 'MyGO', is_favorite: false }
  ];

  var dbPromise = null;
  var db = null;

  // ---- 内部工具 ----

  function getStoreCfg(name) {
    for (var i = 0; i < STORES.length; i++) { if (STORES[i].name === name) return STORES[i]; }
    return null;
  }

  function isAutoIncrement(name) {
    var cfg = getStoreCfg(name);
    return !!(cfg && cfg.autoIncrement);
  }

  /** 写入前补 id / created_at / updated_at */
  function prepareForWrite(store, obj, action) {
    var rec = obj || {};
    var tf = TIME_FIELDS[store] || {};
    var now = Date.now();
    if (action === 'add') {
      if (isAutoIncrement(store)) { if (rec.id == null) delete rec.id; }
      if (tf.created && rec.created_at == null) rec.created_at = now;
      if (tf.updated && rec.updated_at == null) rec.updated_at = now;
    } else if (action === 'put') {
      if (tf.updated && rec.updated_at == null) rec.updated_at = now;
      else if (tf.updated) rec.updated_at = now;
    }
    return rec;
  }

  function assertStore(name) {
    if (!getStoreCfg(name)) throw new Error('未知的 objectStore: ' + name);
  }

  // ---- 建库与种子 ----

  function createSchema(idb, tx) {
    STORES.forEach(function (cfg) {
      var os;
      if (!idb.objectStoreNames.contains(cfg.name)) {
        os = idb.createObjectStore(cfg.name, { keyPath: cfg.keyPath, autoIncrement: !!cfg.autoIncrement });
      } else {
        os = tx.objectStore(cfg.name);
      }
      cfg.indexes.forEach(function (idxName) {
        if (!os.indexNames.contains(idxName)) {
          os.createIndex(idxName, idxName, { unique: false });
        }
      });
    });
  }

  /** 仅在首次建库（oldVersion < 1）时写入种子数据，避免升级时覆盖用户数据 */
  function seedData(tx) {
    var enumsOS = tx.objectStore('enums');
    Object.keys(ENUMS_PRESET).forEach(function (k) {
      enumsOS.put({ key: k, values: ENUMS_PRESET[k].slice() });
    });

    var settingsOS = tx.objectStore('settings');
    Object.keys(SETTINGS_DEFAULTS).forEach(function (k) {
      settingsOS.put({ key: k, value: JSON.stringify(SETTINGS_DEFAULTS[k]) });
    });

    var charOS = tx.objectStore('characters');
    CHARACTER_SEED.forEach(function (c) { charOS.add(c); });
  }

  /** 打开数据库（幂等，缓存单例） */
  function initDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (e) {
        var idb = req.result;
        var tx = req.transaction;
        createSchema(idb, tx);
        if ((e.oldVersion || 0) < 1) {
          // 版本1：首次建库写入种子（后续版本升级在此追加兼容迁移）
          seedData(tx);
        }
      };

      req.onsuccess = function () {
        db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (err) {} db = null; dbPromise = null; };
        loadSettingsCache(db).then(function () {
          // 兜底：若 characters 被清空（如恢复空备份），重新播种种子角色（G-01）
          try {
            var cTx = db.transaction('characters', 'readonly');
            var cReq = cTx.objectStore('characters').count();
            cReq.onsuccess = function () {
              if (cReq.result === 0) {
                var wTx = db.transaction('characters', 'readwrite');
                var os = wTx.objectStore('characters');
                CHARACTER_SEED.forEach(function (c) { os.add(c); });
              }
            };
          } catch (e) { /* 忽略 */ }
          resolve(db);
        }, function () { resolve(db); });
      };

      req.onerror = function () { reject(req.error || new Error('打开数据库失败')); };
      req.onblocked = function () { reject(new Error('数据库被其他标签页占用，请关闭后重试')); };
    });
    return dbPromise;
  }

  /** 把 settings 载入 EATG.runtime（供同步换算函数读取） */
  function loadSettingsCache(idb) {
    return new Promise(function (resolve) {
      var tx = idb.transaction(['settings'], 'readonly');
      var req = tx.objectStore('settings').getAll();
      req.onsuccess = function () {
        var map = {};
        (req.result || []).forEach(function (r) { map[r.key] = r.value; });
        applySettingsToRuntime(map);
        resolve();
      };
      req.onerror = function () { resolve(); };
    });
  }

  function applySettingsToRuntime(map) {
    var rt = (EATG.runtime = EATG.runtime || {});
    try { if (map.default_currency != null) rt.defaultCurrency = JSON.parse(map.default_currency); } catch (e) {}
    try {
      if (map.exchange_rate != null) {
        var ex = JSON.parse(map.exchange_rate);
        if (ex && isFinite(Number(ex.rate))) rt.exchangeRate = Number(ex.rate);
      }
    } catch (e) {}
    try { if (map.image_quality != null) rt.imageQuality = JSON.parse(map.image_quality); } catch (e) {}
  }

  function requireDB() {
    if (db) return Promise.resolve(db);
    return initDB();
  }

  // ---- 通用事务执行 ----

  /** 单 store 事务：fn(objectStore) 返回 IDBRequest；事务完成后 resolve(result) */
  function runTx(store, mode, fn) {
    assertStore(store);
    return requireDB().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction(store, mode);
        var os = tx.objectStore(store);
        var result;
        var request = fn(os);
        if (request) {
          request.onsuccess = function () { result = request.result; };
          request.onerror = function () { reject(request.error); };
        }
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error('事务执行失败')); };
        tx.onabort = function () { reject(tx.error || new Error('事务已中止')); };
      });
    });
  }

  // ---- 公开接口（全部 Promise 化） ----

  function add(store, obj) {
    var rec = prepareForWrite(store, obj, 'add');
    return runTx(store, 'readwrite', function (os) { return os.add(rec); })
      .then(function (key) {
        if (isAutoIncrement(store)) rec.id = key; // 回填自增 id
        return key;
      });
  }

  function put(store, obj) {
    var rec = prepareForWrite(store, obj, 'put');
    return runTx(store, 'readwrite', function (os) { return os.put(rec); });
  }

  function get(store, id) {
    return runTx(store, 'readonly', function (os) { return os.get(id); });
  }

  function getAll(store) {
    return runTx(store, 'readonly', function (os) { return os.getAll(); })
      .then(function (list) { return list || []; });
  }

  function del(store, id) {
    return runTx(store, 'readwrite', function (os) { return os.delete(id); });
  }

  function query(store, index, value) {
    assertStore(store);
    return requireDB().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction(store, 'readonly');
        var os = tx.objectStore(store);
        var idx = os.index(index);
        var request = idx.getAll(value);
        var out;
        request.onsuccess = function () { out = request.result || []; };
        request.onerror = function () { reject(request.error); };
        tx.oncomplete = function () { resolve(out || []); };
        tx.onerror = function () { reject(tx.error || new Error('查询失败')); };
      });
    });
  }

  function queryRange(store, index, lower, upper) {
    assertStore(store);
    var hasLower = lower !== undefined && lower !== null;
    var hasUpper = upper !== undefined && upper !== null;
    return requireDB().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var range = null;
        if (hasLower && hasUpper) range = global.IDBKeyRange.bound(lower, upper);
        else if (hasLower) range = global.IDBKeyRange.lowerBound(lower);
        else if (hasUpper) range = global.IDBKeyRange.upperBound(upper);

        var tx = idb.transaction(store, 'readonly');
        var os = tx.objectStore(store);
        var idx = os.index(index);
        var request = range ? idx.getAll(range) : idx.getAll();
        var out;
        request.onsuccess = function () { out = request.result || []; };
        request.onerror = function () { reject(request.error); };
        tx.oncomplete = function () { resolve(out || []); };
        tx.onerror = function () { reject(tx.error || new Error('范围查询失败')); };
      });
    });
  }

  function count(store, index, value) {
    assertStore(store);
    return requireDB().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction(store, 'readonly');
        var os = tx.objectStore(store);
        var request;
        if (index) {
          request = (value === undefined) ? os.index(index).count() : os.index(index).count(value);
        } else {
          request = os.count();
        }
        var n;
        request.onsuccess = function () { n = request.result; };
        request.onerror = function () { reject(request.error); };
        tx.oncomplete = function () { resolve(n || 0); };
        tx.onerror = function () { reject(tx.error || new Error('计数失败')); };
      });
    });
  }

  /**
   * 跨 store 原子批量写（事务保证全成功或全回滚；用于分摊保存、卖出联动、级联删除等）
   * @param {string|string[]} stores 参与事务的 store 名（可单个或数组）
   * @param {Array<{action:'add'|'put'|'del', store?:string, value?:object, key?:any}>} ops
   * @returns {Promise<any[]>} 各操作返回的主键数组
   */
  function bulk(stores, ops) {
    var list = Array.isArray(stores) ? stores.slice() : [stores];
    (ops || []).forEach(function (op) {
      if (op && op.store && list.indexOf(op.store) === -1) list.push(op.store);
    });
    list.forEach(assertStore);
    var defaultStore = Array.isArray(stores) ? stores[0] : stores;

    return requireDB().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction(list, 'readwrite');
        var results = [];
        try {
          (ops || []).forEach(function (op, i) {
            var name = op.store || defaultStore;
            var os = tx.objectStore(name);
            var action = op.action || 'add';
            var r;
            if (action === 'add') { r = os.add(prepareForWrite(name, op.value, 'add')); }
            else if (action === 'put') { r = os.put(prepareForWrite(name, op.value, 'put')); }
            else if (action === 'del' || action === 'delete') { r = os.delete(op.key); }
            else { throw new Error('bulk 不支持的操作: ' + action); }
            r.onsuccess = (function (idx) {
              return function () { results[idx] = r.result; };
            })(i);
          });
        } catch (err) {
          try { tx.abort(); } catch (e2) {}
          reject(err);
          return;
        }
        tx.oncomplete = function () { resolve(results); };
        tx.onerror = function () { reject(tx.error || new Error('批量事务失败')); };
        tx.onabort = function () { reject(tx.error || new Error('批量事务已中止')); };
      });
    });
  }

  // ---- settings 便捷读写（value 按字典 §2.11 以 JSON 字符串存储） ----

  function getSetting(key) {
    return get('settings', key).then(function (rec) {
      if (!rec) return undefined;
      try { return JSON.parse(rec.value); } catch (e) { return rec.value; }
    });
  }

  function setSetting(key, value) {
    var rec = { key: key, value: JSON.stringify(value) };
    return runTx('settings', 'readwrite', function (os) { return os.put(rec); })
      .then(function () {
        if (key === 'exchange_rate' && value && isFinite(Number(value.rate))) {
          EATG.runtime.exchangeRate = Number(value.rate);
        }
        if (key === 'default_currency') { EATG.runtime.defaultCurrency = value; }
        if (key === 'image_quality') { EATG.runtime.imageQuality = value; }
        return key;
      });
  }

  // ---- 导出 ----

  var S = (EATG.storage = EATG.storage || {});
  S.DB_NAME = DB_NAME;
  S.DB_VERSION = DB_VERSION;
  S.STORES = STORES;
  S.ENUMS_PRESET = ENUMS_PRESET;
  S.SETTINGS_DEFAULTS = SETTINGS_DEFAULTS;
  S.CHARACTER_SEED = CHARACTER_SEED;

  S.initDB = initDB;
  S.add = add;
  S.put = put;
  S.get = get;
  S.getAll = getAll;
  S.del = del;
  S.query = query;
  S.queryRange = queryRange;
  S.count = count;
  S.bulk = bulk;
  S.getSetting = getSetting;
  S.setSetting = setSetting;

})(window);
