/* ==========================================================================
   一咕（EATG）· 图鉴清单导入 / 在线更新（js/gallery_import.js）
   能力：1 导入本地图鉴清单 JSON（format=eatg-gallery-seed）
        2 在线检查更新：从清单地址拉取最新 JSON，增量合并（同角色同名跳过）
   规则：仅新增去重，不覆盖已存在条目（保护手动 owned/关联 goods_id）
        角色不存在时自动创建（ip 取清单 ip 或 MyGO）
   入口：图鉴页顶部按钮「导」（EATG.galleryImport.open）
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;
  var UI = EATG.ui;
  var GI = (EATG.galleryImport = EATG.galleryImport || {});

  var DEFAULT_URL = 'https://raw.githubusercontent.com/kmjhr/eatg/main/app/data/gallery_seed_soyo.json';

  function esc(s) { return UI.esc(s == null ? '' : String(s)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /** 解析并校验清单 JSON */
  function parse(text) {
    var data = JSON.parse(text);
    if (!data || data.format !== 'eatg-gallery-seed' || !Array.isArray(data.items)) {
      throw new Error('不是有效的图鉴清单：缺少 format=eatg-gallery-seed 或 items 数组');
    }
    return data;
  }

  /** 导入：按角色合并去重；同名已存在 → 只补缺失的只读元数据（图/系列/类型/价格/来源），
      绝不覆盖 owned / goods_id。返回 { added, updated, skipped, charName } */
  function importData(data) {
    var charName = String(data.character || '').trim();
    var ip = String(data.ip || 'MyGO').trim();
    var items = data.items || [];
    if (!items.length) return Promise.resolve({ added: 0, updated: 0, skipped: 0, charName: charName });

    return S.getAll('characters').then(function (chars) {
      var c = null;
      if (charName) {
        for (var i = 0; i < chars.length; i++) {
          if ((chars[i].name || '') === charName) { c = chars[i]; break; }
        }
      }
      if (c) return c;
      // 角色不存在 → 自动创建
      return S.add('characters', { name: charName || '未命名角色', ip: ip, is_favorite: chars.length === 0 })
        .then(function (id) { return { id: Number(id), name: charName }; });
    }).then(function (c) {
      return S.getAll('gallery_items').then(function (existing) {
        var byName = {};
        existing.forEach(function (it) {
          if (it.character_id === c.id) byName[String(it.name || '')] = it;
        });
        var toAdd = [], toUpdate = [], skipped = 0;
        items.forEach(function (it) {
          var name = String(it.name || '').trim();
          if (!name) return;
          var old = byName[name];
          if (old) {
            skipped++;
            // 补漏不覆盖：仅当旧条目缺字段时补充只读元数据
            var changed = false;
            var fill = { image: 1, series: 1, goods_type: 1, price_jpy: 1, source: 1, source_url: 1, jp_name: 1 };
            for (var k in fill) {
              if (!Object.prototype.hasOwnProperty.call(fill, k)) continue;
              if (!old[k] && it[k] != null && it[k] !== '') {
                old[k] = it[k]; changed = true;
              }
            }
            if (changed) toUpdate.push(old);
            return;
          }
          byName[name] = { character_id: c.id, name: name }; // 占位防同清单内重复
          toAdd.push({
            character_id: c.id,
            name: name,
            series: String(it.series || '').trim() || '',
            release_date: String(it.release_date || '').trim() || '',
            goods_type: String(it.goods_type || '').trim() || '',
            price_jpy: num(it.price_jpy) || 0,
            source: String(it.source || '').trim() || '',
            source_url: String(it.source_url || '').trim() || '',
            jp_name: String(it.jp_name || '').trim() || '',
            image: String(it.image || '').trim() || '',
            owned: false,
            goods_id: null
          });
        });
        function chunkPut(list, size, fn) {
          size = size || 50;
          var i = 0;
          function next() {
            if (i >= list.length) return Promise.resolve();
            var batch = list.slice(i, i + size);
            i += size;
            return Promise.all(batch.map(function (v) { return fn(v); })).then(next);
          }
          return next();
        }
        return chunkPut(toAdd, 50, function (v) { return S.add('gallery_items', v); }).then(function () {
          return chunkPut(toUpdate, 50, function (v) { return S.put('gallery_items', v); });
        }).then(function () {
          return { added: toAdd.length, updated: toUpdate.length, skipped: skipped, charName: c.name || charName };
        });
      });
    });
  }

  GI.importText = function (text) {
    return importData(parse(text));
  };

  /** 打开导入/更新面板（ctx: { reload }） */
  GI.open = function (ctx) {
    var body = '<div class="form-section">' +
      '<div class="field"><div class="field-head"><label class="field-label">方式一 · 导入本地清单文件（.json）</label></div>' +
        '<input type="file" id="gi-file" accept=".json,application/json" hidden>' +
        '<button type="button" class="btn btn--secondary" id="gi-file-btn">选择清单文件…</button>' +
      '</div>' +
      '<div class="field"><div class="field-head"><label class="field-label">方式二 · 在线检查更新</label></div>' +
        '<input id="gi-url" class="input" type="text" value="' + esc(DEFAULT_URL) + '">' +
        '<p class="muted" style="font-size:12px">拉取最新清单并增量合并；私有仓库会拉取失败，请改用本地导入</p>' +
      '</div>' +
    '</div>';
    var ref = UI.sheet({
      title: '导入图鉴清单',
      bodyHTML: body,
      footerHTML:
        '<button type="button" class="btn btn--secondary" data-act="online">检查更新</button>' +
        '<button type="button" class="btn btn--primary" data-act="local">导入本地文件</button>'
    });
    var fileInput = document.getElementById('gi-file');
    var fileBtn = document.getElementById('gi-file-btn');
    if (fileBtn) fileBtn.addEventListener('click', function () { if (fileInput) fileInput.click(); });

    ref.el.addEventListener('click', function (e) {
      var act = e.target.dataset.act;
      if (act === 'local') {
        if (!fileInput || !fileInput.files || !fileInput.files.length) {
          UI.toast('请先选择清单文件', 'error');
          return;
        }
        var f = fileInput.files[0];
        var reader = new FileReader();
        reader.onload = function () {
          var data;
          try { data = parse(reader.result); }
          catch (err) { UI.toast('文件解析失败：' + (err && err.message || err), 'error'); return; }
          importData(data).then(function (r) {
            UI.toast('导入完成：新增 ' + r.added + ' 条，补图/补信息 ' + r.updated + ' 条，跳过重复 ' + r.skipped + ' 条（' + r.charName + '）', 'success');
            ref.close();
            if (ctx && ctx.reload) ctx.reload();
          }).catch(function (err) {
            UI.toast('导入失败：' + (err && err.message || err), 'error');
          });
        };
        reader.onerror = function () { UI.toast('文件读取失败', 'error'); };
        reader.readAsText(f);
      }
      else if (act === 'online') {
        var url = ((document.getElementById('gi-url') || {}).value || '').trim() || DEFAULT_URL;
        UI.toast('正在检查更新…');
        fetch(url, { cache: 'no-store' }).then(function (res) {
          if (!res.ok) throw new Error('拉取失败（HTTP ' + res.status + '）：清单地址不可用或仓库为私有');
          return res.text();
        }).then(function (text) {
          return importData(parse(text));
        }).then(function (r) {
          UI.toast('更新完成：新增 ' + r.added + ' 条，补图/补信息 ' + r.updated + ' 条，跳过重复 ' + r.skipped + ' 条', 'success');
          ref.close();
          if (ctx && ctx.reload) ctx.reload();
        }).catch(function (err) {
          UI.toast('检查更新失败：' + (err && err.message || err), 'error');
        });
      }
    });
  };

})(window);
