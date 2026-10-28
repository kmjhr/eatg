/* ==========================================================================
   一咕（EATG）· RSS 抓取模块（js/rss.js）
   实现：监控源（sources）里类型为 RSS（或填了真实 feed 地址）的源，
        通过 直连 → rss2json → allorigins → codetabs 逐级尝试，
        解析 RSS 2.0 / Atom（XML 或 rss2json JSON），
        自动翻译标题/摘要为中文（Google 免费端点，批量一次请求），
        提取条目图片（thumbnail / enclosure / media: 标签 / description 内 img），
        去重后写入 news 表（source_id 关联监控源），供资讯页展示。
   说明：纯前端无法保证后台定时，自动抓取发生在打开资讯页时（按频率判断）；
        翻译失败/抓取失败时自动回退原文并给出可读提示。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;

  // 单次抓取最多写入条数（避免首次全量写入过多）
  var MAX_PER_FETCH = 50;
  var FETCH_TIMEOUT = 12000; // 单次请求超时 12s
  var DESC_MAX = 300;        // 摘要最大长度
  var DESC_TRANSLATE_N = 6;  // 摘要翻译条数（避免请求过大）

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

  function fetchJSON(url) {
    return fetchText(url).then(function (t) { return JSON.parse(t); });
  }

  /** 直连 → 公共代理逐级尝试，返回 { xml } 或 { json }（rss2json） */
  function getFeed(url) {
    // 1) 直连（RSS 源自身支持 CORS 时最快）
    return fetchText(url).then(function (t) { return { xml: t }; })
    // 2) rss2json（JSON，CORS 友好，实测可用）
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

  function textOf(parent, tag) {
    var el = parent.getElementsByTagName(tag)[0];
    return el ? (el.textContent || '').trim() : '';
  }

  /** 从 XML 条目里提取图片 URL */
  function xmlItemImage(it) {
    var enc = it.getElementsByTagName('enclosure')[0];
    if (enc) {
      var t = enc.getAttribute('type') || '';
      var u = enc.getAttribute('url');
      if (u && t.indexOf('image') === 0) return u;
    }
    var mc = it.getElementsByTagName('media:content')[0];
    if (mc && mc.getAttribute('url')) return mc.getAttribute('url');
    var mt = it.getElementsByTagName('media:thumbnail')[0];
    if (mt && mt.getAttribute('url')) return mt.getAttribute('url');
    var ii = it.getElementsByTagName('itunes:image')[0];
    if (ii && ii.getAttribute('href')) return ii.getAttribute('href');
    var links = it.getElementsByTagName('link');
    for (var i = 0; i < links.length; i++) {
      var rel = links[i].getAttribute('rel');
      if (rel === 'enclosure' || rel === 'image') {
        var h = links[i].getAttribute('href');
        if (h) return h;
      }
    }
    var desc = textOf(it, 'description') || textOf(it, 'summary') || '';
    var m = /<img[^>]+src=["']([^"']+)["']/i.exec(desc);
    return m ? m[1] : '';
  }

  /** 解析 RSS 2.0（<item>）或 Atom（<entry>）→ 统一条目 */
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
        desc: textOf(it, 'description') || textOf(it, 'summary') || '',
        image: xmlItemImage(it)
      });
    }
    if (!out.length) throw new Error('RSS 里没有可用的条目');
    return out;
  }

  /** 解析 rss2json 返回的 JSON → 统一条目 */
  function parseJSONItems(j) {
    var items = j.items || [];
    return items.map(function (it) {
      var img = (it.thumbnail || (it.enclosure && it.enclosure.image) || '');
      if (!img) {
        var m = /<img[^>]+src=["']([^"']+)["']/i.exec(it.description || '');
        if (m) img = m[1];
      }
      return {
        title: (it.title || '').trim(),
        link: it.link || '',
        date: it.pubDate || it.published || it.updated || '',
        desc: it.description || it.content || '',
        image: img
      };
    }).filter(function (it) { return it.title; });
  }

  /** 统一入口：{xml} 或 {json} → 统一条目数组 */
  function parseFeed(feed) {
    return feed.json ? parseJSONItems(feed.json) : parseXMLItems(feed.xml);
  }

  function stripHTML(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** 检测是否含日文假名（平假名/片假名）——日文标题即使全汉字+假名混排也算日文 */
  function hasKana(s) {
    return /[\u3040-\u30ff\uff66-\uff9f]/.test(s);
  }

  /** 单语言批量翻译；返回 { segs: 与 texts 等长数组(null=未翻译/与原文相同), lang: 检测语言 } */
  function trans(sl, texts) {
    var q = texts.join('\n');
    return fetchJSON('https://translate.googleapis.com/translate_a/single?client=gtx&sl=' + sl + '&tl=zh-CN&dt=t&q=' + encodeURIComponent(q))
      .then(function (j) {
        var arr = j && j[0];
        var lang = (j && j[2]) || '';
        if (!arr || !arr.length) return { segs: texts.map(function () { return null; }), lang: lang };
        return {
          lang: lang,
          segs: texts.map(function (t, k) {
            var seg = arr[k];
            return (seg && seg[0] && seg[0] !== t) ? seg[0] : null;
          })
        };
      })
      .catch(function () { return { segs: texts.map(function () { return null; }), lang: '' }; });
  }

  /** 批量翻译（一次请求，\n 分隔）。
      分组：含假名 → 强制 ja→zh-CN（避免 auto 把日文误判为中文）；
            其余 → auto→zh-CN，若 auto 原样返回、检测语言非中文、且含汉字
                   （疑似日文汉字标题被误判），再用 sl=ja 重试一次。 */
  function translateBatch(texts) {
    var out = texts.map(function () { return null; });
    var ja = [], jaIdx = [], other = [], otherIdx = [];
    texts.forEach(function (t, i) {
      if (!t) return;
      if (hasKana(t)) { ja.push(t); jaIdx.push(i); }
      else { other.push(t); otherIdx.push(i); }
    });
    var chain = Promise.resolve();
    if (ja.length) {
      chain = chain.then(function () {
        return trans('ja', ja).then(function (res) {
          res.segs.forEach(function (s, k) { if (s) out[jaIdx[k]] = s; });
        });
      });
    }
    if (other.length) {
      chain = chain.then(function () {
        return trans('auto', other).then(function (res) {
          var retry = [], retryK = [];
          res.segs.forEach(function (s, k) {
            if (s) out[otherIdx[k]] = s;
            else if (res.lang !== 'zh' && /[\u4e00-\u9fff]/.test(other[k])) { retry.push(other[k]); retryK.push(k); }
          });
          if (retry.length) {
            return trans('ja', retry).then(function (res2) {
              res2.segs.forEach(function (s, k) { if (s) out[otherIdx[retryK[k]]] = s; });
            });
          }
        });
      });
    }
    return chain.then(function () { return out; }).catch(function () { return out; });
  }

  /** 抓取单个监控源 → { ok, added, skipped, error, ms }；成功时写回 last_fetch_at/last_result */
  function fetchSource(src) {
    if (!src || !src.url) return Promise.resolve({ ok: false, added: 0, skipped: 0, error: '缺少地址', ms: 0 });
    var t0 = Date.now();
    var sid = Number(src.id);
    return getFeed(src.url).then(function (feed) {
      var items = parseFeed(feed);
      var take = items.slice(0, MAX_PER_FETCH);
      // 翻译：标题全量（一次请求）+ 摘要前 N 条（一次请求）
      return translateBatch(take.map(function (it) { return it.title; })).then(function (titleZh) {
        return translateBatch(take.slice(0, DESC_TRANSLATE_N).map(function (it) { return stripHTML(it.desc).slice(0, DESC_MAX); }))
          .then(function (descZh) {
            return { items: take, titleZh: titleZh, descZh: descZh };
          });
      });
    }).then(function (pack) {
      var items = pack.items;
      var titleZh = pack.titleZh;
      var descZh = pack.descZh;
      return S.query('news', 'source_id', sid).then(function (exist) {
        var existList = exist || [];
        // 旧数据补翻：已存在且标题含日文假名、且没有译文（title_raw）的条目，重新翻译更新
        var needRepair = existList.filter(function (n) { return n.title && !n.title_raw && hasKana(n.title); });
        var repairChain = Promise.resolve();
        if (needRepair.length) {
          repairChain = translateBatch(needRepair.map(function (n) { return n.title; })).then(function (zhs) {
            var updates = [];
            needRepair.forEach(function (n, i) {
              var zh = zhs[i];
              if (zh && zh !== n.title) {
                n.title_raw = n.title;
                n.title = zh;
                updates.push(n);
              }
            });
            var w = Promise.resolve();
            updates.forEach(function (n) { w = w.then(function () { return S.put('news', n); }); });
            return w;
          });
        }
        return repairChain.then(function () { return { items: items, titleZh: titleZh, descZh: descZh, existList: existList }; });
      });
    }).then(function (pack) {
      var items = pack.items;
      var titleZh = pack.titleZh;
      var descZh = pack.descZh;
      var existList = pack.existList;
      var have = {};
      existList.forEach(function (n) {
        if (n.link) have[n.link] = 1;
        else if (n.title_raw) have['t:' + n.title_raw] = 1;
        else if (n.title) have['t:' + n.title] = 1;
      });
        var skipped = 0;
        var recs = [];
        items.forEach(function (it, i) {
          var key = it.link ? it.link : ('t:' + it.title);
          if (have[key]) { skipped++; return; }
          have[key] = 1;
          var zh = titleZh[i];
          var desc = stripHTML(it.desc).slice(0, DESC_MAX);
          var descZhText = i < DESC_TRANSLATE_N ? (descZh[i] || '') : '';
          recs.push({
            source_id: sid,
            title: zh || it.title,
            title_raw: zh ? it.title : '',
            link: it.link,
            channel: src.name || 'RSS',
            image: it.image || '',
            pub_date: it.date,
            note: (descZhText || desc),
            is_read: false,
            status: ''
          });
        });
        var write = Promise.resolve();
        recs.forEach(function (r) { write = write.then(function () { return S.add('news', r); }); });
        return write.then(function () {
          return { ok: true, added: recs.length, skipped: skipped, error: null, ms: Date.now() - t0 };
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
