/* ==========================================================================
   一咕（EATG）· 视觉识别模块（js/vision.js v4）
   调用视觉大模型出「谷子包围框」，只数个数+给框，不识别名称/IP/角色。
   实测（2026-10）：
     - glm-4.6v-flash 免费档持续 429 限流 → 不设为默认
     - glm-4.1v-thinking-flash 免费、能通、框准，但返回像素坐标（>1）
     - glm-4v-flash 旧免费模型能通但能力弱，作为降级
   兼容：自动识别像素坐标并按图尺寸归一化；429 自动等 2 秒重试一次；主模型失败降级 glm-4v-flash。
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;

  var DEFAULTS = {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4.1v-thinking-flash',
    key: ''
  };

  var PROMPT = '这是一张桌面上摆放「二次元动漫周边商品」的照片（这种周边在中文黑话里叫"谷子"）。' +
    '任务：数清图中有几个独立的动漫周边商品，并给每个商品画一个紧贴边缘的包围矩形框。' +
    '只数这四类：①圆形吧唧/金属徽章；②拍立得/明信片/印刷小卡片（纸片）；③亚克力立牌；④挂件/钥匙扣。' +
    '绝对不要数：葡萄、水果、树叶、植物、花、砖块、水泥、阴影、手指、桌面纹理、包装盒。' +
    '物品互相重叠时各自独立画框，不要合并。' +
    '严格只返回 JSON，不要解释、不要 markdown 代码块、不要任何前后缀文字：' +
    '{"count":总数,"boxes":[[x1,y1,x2,y2],...]}，坐标左上角为原点。';

  /** 从模型返回文本中提取首个 JSON 对象（容忍 ```json 包裹/前后杂字） */
  function parseJson(text) {
    var m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }

  /**
   * 归一化 box → {x,y,w,h}，过滤碎框。
   * 兼容两种坐标：0~1 小数 / 像素坐标（端点 >1.5）。
   * imgW/imgH 为原图像素尺寸，用于像素坐标归一化；缺失时按 max 值兜底。
   */
  function toBoxes(data, imgW, imgH) {
    var arr = (data && data.boxes) || [];
    var out = [];
    var isPixel = arr.some(function (b) {
      return Array.isArray(b) && b.length >= 4 &&
        (Number(b[0]) > 1.5 || Number(b[2]) > 1.5 || Number(b[1]) > 1.5 || Number(b[3]) > 1.5);
    });
    arr.forEach(function (b) {
      if (!Array.isArray(b) || b.length < 4) return;
      var x1 = Number(b[0]), y1 = Number(b[1]), x2 = Number(b[2]), y2 = Number(b[3]);
      if (isPixel) {
        if (imgW && imgH) {
          x1 /= imgW; x2 /= imgW; y1 /= imgH; y2 /= imgH;
        } else {
          var mx = Math.max(x1, x2) || 1, my = Math.max(y1, y2) || 1;
          x1 /= mx; x2 /= mx; y1 /= my; y2 /= my;
        }
      }
      x1 = Math.min(1, Math.max(0, x1));
      y1 = Math.min(1, Math.max(0, y1));
      x2 = Math.min(1, Math.max(0, x2));
      y2 = Math.min(1, Math.max(0, y2));
      var x = Math.min(x1, x2), y = Math.min(y1, y2);
      var w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      if (w < 0.03 || h < 0.03 || w * h < 0.004) return;
      out.push({ x: x, y: y, w: w, h: h });
    });
    return out.slice(0, 9);
  }

  function callApi(url, key, model, dataUrl) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }],
        temperature: 0.1
      }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (resp) {
      if (!resp.ok) {
        var e = new Error('视觉服务 HTTP ' + resp.status);
        e.status = resp.status;
        throw e;
      }
      return resp.json();
    }).then(function (json) {
      var msg = json && json.choices && json.choices[0] && json.choices[0].message;
      var text = msg && msg.content;
      if (!text) return null;
      return parseJson(text);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('请求超时（60秒），手机网络上传图片太慢，建议换 WiFi 或光线好的环境');
      }
      throw err;
    }).then(function (data) {
      if (timer) clearTimeout(timer);
      return data;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /**
   * detectBoxes(dataUrl, imgW, imgH) → Promise<[{x,y,w,h}]>（0~1 归一化）
   * imgW/imgH 建议传（原图像素宽高），用于把像素坐标归一化。
   * 未配 Key 时 reject（code==='NO_KEY'），调用方回退本地 OCR。
   */
  EATG.vision = {
    detectBoxes: function (dataUrl, imgW, imgH) {
      return S.getSetting('vision_api').then(function (cfg) {
        cfg = cfg || {};
        var url = cfg.url || DEFAULTS.url;
        var key = cfg.key || DEFAULTS.key;
        if (!key) { var e = new Error('未配置视觉识别 API Key'); e.code = 'NO_KEY'; throw e; }

        var primary = cfg.model || DEFAULTS.model;
        var fallback = (primary !== 'glm-4v-flash') ? 'glm-4v-flash' : null;

        return callApi(url, key, primary, dataUrl)
          .catch(function (err) {
            // 429 限流：等 2 秒重试一次
            if (err && err.status === 429) {
              console.warn('[EATG] 视觉服务 429，2 秒后重试…');
              return sleep(2000).then(function () {
                return callApi(url, key, primary, dataUrl);
              });
            }
            throw err;
          })
          .catch(function (err) {
            // 主模型彻底失败：降级旧免费模型 glm-4v-flash
            if (fallback) {
              console.warn('[EATG] 主模型失败，降级到', fallback, err && err.message);
              return callApi(url, key, fallback, dataUrl).catch(function () { throw err; });
            }
            throw err;
          })
          .then(function (data) {
            return toBoxes(data, imgW, imgH);
          });
      });
    }
  };

})(window);
