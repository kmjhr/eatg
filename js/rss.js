/* ==========================================================================
   一咕（EATG）· RSS 抓取模块（js/rss.js）
   实现：监控源（sources）里类型为 RSS（或填了真实 feed 地址）的源，
        通过 直连 → 公共 CORS 代理 逐级尝试，解析 RSS 2.0 / Atom，
        去重后写入 news 表（source_id 关联监控源），供资讯页展示。
   说明：纯前端无法保证后台定时，自动抓取发生在打开资讯页时（按频率判断）；
        抓取失败/被 CORS 拦截时给出可读提示。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;

  // 单次抓取最多写入条数（避免首次全量写入过多）
  var MAX_PER_FETCH = 50;
  var FETCH_TIMEOUT = 12000; // 单次请求超时 12s

  function fetchText(url) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT) : null;
    return fetch(url, {
      cache: 'no-store',
      redirect: 'follow',
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (t) {
      if (timer) clearTimeout(timer);
      return t;
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('请求超时');
      throw err;
    });
  }

  /** 直连 → 公共代理逐级尝试，返回 { xml } 或 { json }（rss2json） */
  function getFeed(url) {
    // 1) 直连（RSS 源自身支持 CORS 时最快）
    return fetchText(url).then(function (t) { return { xml: t }; })
    // 2) rss2json（JSON，CORS 友好，2026-10 实测可用）
    .catch(function () {
      return fetchJSON('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url)).then(function (j) {
        if (!j || j.status !== 'ok') throw new Error((j && j.message) || 'RSS2JSON 返回异常');
        return { json: j };
      });
    })
    // 3) allorigins raw（XML）
    .catch(function () {
      return fetchText('https://api.allorigins.win/raw?url=' + encodeURIComponent(url)).then(function (t) { return { xml: t }; });
    })
    // 4) codetabs（XML）
    .catch(function () {
      return fetchText('https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url)).then(function (t) { return { xml: t }; });
    });
  }

  function fetchJSON(url) {
    return fetchText(url).then(function (t) { return JSON.parse(t); });
  }

  function textOf(parent, tag) {
    var el = parent.getElementsByTagName(tag)[0];
    return el ? (el.textContent || '').trim() : '';
  }

  /** 解析 RSS 2.0（<item>）或 Atom（<entry>） */
  function parseXMLItems(xmlText) {
    var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('返回内容不是有效的 RSS/XML');
    var nodes = doc.getElementsByTagName('item');
    var isAtom = nodes.length === 0;
    if (isAtom) nodes = doc.getElementsByTagName('entry');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var it = nodes[i];
      var title = textOf(it, 'title');
      if (!title) continue;
      var link = textOf(it, 'link');
      if (!link && isAtom) {
        var la = it.getElementsByTagName('link')[0];
        if (la && la.getAttribute('href')) link = la.getAttribute('href');
      }
      if (!link && !isAtom) {
        var guid = it.getElementsByTagName('guid')[0];
        if (guid && guid.textContent) link = guid.textContent;
      }
      out.push({
        title: title,
        link: link || '',
        date: textOf(it, 'pubDate') || textOf(it, 'published') || textOf(it, 'updated') || '',
        desc: textOf(it, 'description') || textOf(it, 'summary') || ''
      });
    }
    if (!out.length) throw new Error('RSS 里没有可用的条目');
    return out;
  }

  /** 解析 rss2json 返回的 JSON（items 数组） */
  function parseJSONItems(j) {
    var items = j.items || [];
    return items.map(function (it) {
      return {
        title: (it.title || '').trim(),
        link: it.link || '',
        date: it.pubDate || it.published || it.updated || '',
        desc: it.description || it.content || ''
      };
    }).filter(function (it) { return it.title; });
  }

  /** 统一入口：{xml} 或 {json} → 条目数组 */
  function parseFeed(feed) {
    return feed.json ? parseJSONItems(feed.json) : parseXMLItems(feed.xml);
  }

  /** 抓取单个监控源 → { ok, added, skipped, error, ms }；成功时写回 last_fetch_at/last_result */
  function fetchSource(src) {
    if (!src || !src.url) return Promise.resolve({ ok: false, added: 0, skipped: 0, error: '缺少地址', ms: 0 });
    var t0 = Date.now();
    var sid = Number(src.id);
    return getFeed(src.url).then(function (feed) {
      var items = parseFeed(feed);
      var take = items.slice(0, MAX_PER_FETCH);
      return S.query('news', 'source_id', sid).then(function (exist) {
        var have = {};
        (exist || []).forEach(function (n) {
          if (n.link) have[n.link] = 1;
          else if (n.title) have['t:' + n.title] = 1;
        });
        var skipped = 0;
        var recs = [];
        take.forEach(function (it) {
          var key = it.link ? it.link : ('t:' + it.title);
          if (have[key]) { skipped++; return; }
          have[key] = 1;
          recs.push({
            source_id: sid,
            title: it.title,
            link: it.link,
            channel: src.name || 'RSS',
            pub_date: it.date,
            note: it.desc ? it.desc.slice(0, 300) : '',
            is_read: false,
            status: ''
          });
        });
        var write = Promise.resolve();
        recs.forEach(function (r) { write = write.then(function () { return S.add('news', r); }); });
        return write.then(function () {
          return { ok: true, added: recs.length, skipped: skipped, error: null, ms: Date.now() - t0 };
        });
      });
    }).then(function (res) {
      return recordResult(src, res).then(function () { return res; });
    }).catch(function (err) {
      var res = { ok: false, added: 0, skipped: 0, error: (err && err.message) || '抓取失败', ms: Date.now() - t0 };
      return recordResult(src, res).then(function () { return res; });
    });
  }

  function recordResult(src, res) {
    src.last_fetch_at = Date.now();
    src.last_result = { ok: res.ok, added: res.added, error: res.error, at: Date.now() };
    return S.put('sources', src);
  }

  /** 按频率判断是否该自动抓取（realtime=每次 / hourly / daily / weekly） */
  function shouldFetch(src, now) {
    if (!src || !src.enabled || !src.url) return false;
    var last = src.last_fetch_at || 0;
    var ms = intervalMs(src.fetch_interval);
    return (now - last) >= ms;
  }

  function intervalMs(interval) {
    if (interval === 'realtime') return 0;
    if (interval === 'hourly') return 3600000;
    if (interval === 'weekly') return 7 * 86400000;
    return 86400000; // daily
  }

  /** 自动抓取所有「启用且到期」的源（资讯页打开时调用）；返回抓了几个源 */
  function autoFetchEnabled(now) {
    now = now || Date.now();
    return S.getAll('sources').then(function (list) {
      var jobs = (list || []).filter(function (s) { return shouldFetch(s, now); });
      if (!jobs.length) return 0;
      return Promise.all(jobs.map(function (src) {
        return fetchSource(src).then(function () { return 1; });
      })).then(function (r) {
        var n = 0;
        r.forEach(function (x) { n += x; });
        return n;
      }).catch(function () { return 0; });
    }).catch(function () { return 0; });
  }

  EATG.rss = {
    fetchSource: fetchSource,
    autoFetchEnabled: autoFetchEnabled,
    shouldFetch: shouldFetch
  };

})(window);
