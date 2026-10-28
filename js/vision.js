/* ==========================================================================
   一咕（EATG）· 视觉识别模块（js/vision.js）
   能力：调用视觉大模型（默认智谱 GLM-4V-Flash）对整张照片出「谷子包围框」
   只负责数个数 + 给框（bbox），不识别名称/IP/角色（那些用户在确认页自己填）。
   配置：settings.vision_api = { url, key, model }（设置页填写，仅存本机）
   ========================================================================== */
(function (global) {
  'use strict';

  var EATG = (global.EATG = global.EATG || {});
  var S = EATG.storage;

  var DEFAULTS = {
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4v-flash',
    key: ''
  };

  var PROMPT = '你是二次元周边盘点助手。这是一张桌面上摆放谷子（动漫周边）的照片。' +
    '任务：数清图中有多少个独立的谷子物品，并给每个物品画一个紧贴边缘的包围矩形框。' +
    '判定规则：一个圆形吧唧=1个，一个亚克力立牌=1个，一个挂件/钥匙扣=1个，一张纸片/明信片=1个；物品重叠时各自独立画框，不要合并；只算周边，不算桌面/手指/阴影/包装盒。' +
    '严格只返回 JSON，不要解释、不要代码块，格式：' +
    '{"count": 总数, "boxes": [[x1,y1,x2,y2], ...]}，坐标 0~1 小数，左上角原点，框紧贴物品边缘。';

  /** 从模型返回文本中提取首个 JSON 对象 */
  function parseJson(text) {
    var m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('模型返回不是 JSON');
    return JSON.parse(m[0]);
  }

  /** 归一化数组框 → {x,y,w,h}，过滤碎框/越界 */
  function toBoxes(data) {
    var arr = (data && data.boxes) || [];
    var out = [];
    arr.forEach(function (b) {
      if (!Array.isArray(b) || b.length < 4) return;
      var x1 = Math.min(1, Math.max(0, Number(b[0])));
      var y1 = Math.min(1, Math.max(0, Number(b[1])));
      var x2 = Math.min(1, Math.max(0, Number(b[2])));
      var y2 = Math.min(1, Math.max(0, Number(b[3])));
      var x = Math.min(x1, x2), y = Math.min(y1, y2);
      var w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      if (w < 0.03 || h < 0.03 || w * h < 0.004) return;   // 过滤碎框
      out.push({ x: x, y: y, w: w, h: h });
    });
    return out.slice(0, 9);
  }

  /**
   * detectBoxes(dataUrl) → Promise<[{x,y,w,h}]>（0~1 归一化）
   * 未配置 Key 时 reject（message === 'NO_KEY'），调用方回退本地 OCR。
   */
  EATG.vision = {
    detectBoxes: function (dataUrl) {
      return S.getSetting('vision_api').then(function (cfg) {
        cfg = cfg || {};
        var url = cfg.url || DEFAULTS.url;
        var model = cfg.model || DEFAULTS.model;
        var key = cfg.key || DEFAULTS.key;
        if (!key) { var e = new Error('未配置视觉识别 API Key'); e.code = 'NO_KEY'; throw e; }

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
          })
        }).then(function (resp) {
          if (!resp.ok) throw new Error('视觉服务 HTTP ' + resp.status);
          return resp.json();
        }).then(function (json) {
          var msg = json && json.choices && json.choices[0] && json.choices[0].message;
          var text = msg && msg.content;
          if (!text) throw new Error('视觉服务无返回内容');
          return toBoxes(parseJson(text));
        });
      });
    }
  };

})(window);
