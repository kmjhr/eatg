# -*- coding: utf-8 -*-
"""cut_badge_gallery.py v5 → 固定网格切格（一格一谷子，最终版）

真实网格（1801x2580 截标题图，实测）：
  12 列 × 17 行；列宽 150、行高 152；起点 x=0、y=0。
徽章分布（人工核验）：
  行1-16 每行 12 格全有；行2 仅 c1-c4（4 徽章）；行17 仅 c1-c7（7 徽章）→ 共 191 格。
名称映射：
  名称条中心列 = round(ROWS.x(千分比) * 1801 / 150)。徽章列 == 名称中心列 → 该名称；
  无名徽章列 → 继承左侧最近名称（同款加序号 (2)(3)...）。
  行2 特殊：c2-c4 = 三专致迹(特装/限定/通常) 拆为 3 款（顺序按图从左到右，可再核改）。
"""
import argparse, cv2, numpy as np, os, json, io
from PIL import Image

X0, COL_W, COLS = 0, 150, 12
ROW_TOP, ROW_H, ROWS_N = 0, 152, 17
PX_PER_MILLE = 1801.0 / 1000.0  # 千分比 → 原图像素

# 徽章掩码：每行有徽章的列（1-based）
BADGE_COLS = [list(range(1, 13)) for _ in range(ROWS_N)]
BADGE_COLS[1] = [1, 2, 3, 4]      # 行2：c1-c4
BADGE_COLS[16] = [1, 2, 3, 4, 5, 6, 7]  # 行17：c1-c7

ROWS = [
 [(22,'一专限定'),(97,'一专通常'),(172,'一单限定'),(247,'二单限定'),(322,'三单限定'),(397,'四单限定'),(472,'五单限定'),(547,'二专限定A'),(622,'二专限定B'),(697,'二专通常'),(772,'六单限定'),(847,'七单限定')],
 [(16,'八单限定A/B'),(96,'三专致迹(特装/限定/通常)')],
 [(21,'迷星叫'),(96,'名无声'),(171,'潜在表明'),(261,'影色舞vol.1'),(361,'TV纪念'),(516,'5th'),(621,'二周年'),(781,'jump'),(936,'GIGO')],
 [(71,'12th'),(191,'C103'),(311,'彷徨渴望zepp'),(431,'水彩'),(516,'BD上/下卷特典'),(681,'对邦'),(766,'对邦特典'),(936,'WEGO')],
 [(16,'visual纪念'),(96,'Weiß Schwarz'),(311,'影色舞vol.2'),(431,'碧泳'),(516,'voyage闪'),(596,'voyage烫银'),(681,'无重力方吧唧'),(766,'无重力'),(936,'夏服GIGO')],
 [(16,'夏服娃娃机正比'),(96,'长条v4'),(241,'6th'),(361,'C104处救生'),(516,'C104处救生'),(596,'国a咖'),(681,'剧场版前篇'),(766,'夏日祭'),(936,'summer向日葵')],
 [(36,'atre常服'),(171,'PalVerse'),(261,'6th上海'),(361,'东京塔'),(516,'花朝月夕'),(621,'花朝月夕'),(681,'花朝月夕75mm'),(851,'剧场版后篇')],
 [(21,'睡衣派对'),(96,'涩谷闪v5'),(211,'Stargazing'),(346,'Stargazing'),(401,'Stargazing75mm'),(516,'Q版'),(596,'罗森联动吧唧'),(661,'罗森联动迷你吧唧'),(781,'7th'),(936,'7th闪')],
 [(21,'go刺对邦'),(96,'长条v5'),(261,'黎明与黄昏'),(431,'毛绒吧唧'),(596,'台湾声优见面会限定'),(851,'良辰共此曲')],
 [(16,'Botania花朵'),(96,'wind'),(311,'2025生日套'),(431,'鸡狗对邦'),(596,'鸡狗对邦(烫色)'),(681,'crychic'),(766,'鸡狗合同企画展'),(936,'日本罗森联动')],
 [(16,'ONKYO耳机联动'),(96,'G店春季推活积分兑换'),(171,'鸡狗对邦扭蛋台词吧唧'),(261,'鸡狗GIGO'),(346,'鸡狗GIGO娃娃机大饼'),(431,'雨中祈晴漫画特典'),(516,'GSC粘土人plus'),(596,'母鸡卡国A咖'),(681,'10周年'),(766,'甜品天堂正比'),(851,'甜品天堂Q'),(936,'信泽收展')],
 [(36,'zepp 2025'),(191,'GO刺快闪'),(311,'GO刺快闪特典'),(431,'bangdream罗森联动'),(516,'bangdream罗森联动特典'),(596,'Dream vacation'),(681,'夏服GIGO正比'),(766,'武士道商店4周年'),(851,'歌...呜...'),(936,'水手服毛绒吧唧')],
 [(16,'台湾水族馆联动'),(96,'台湾水族馆联动'),(261,'雨中祈晴2卷'),(346,'G店十周年满赠'),(431,'剧场版BD特典(前篇/后篇)'),(596,'上海鸡狗对邦迷你吧唧'),(681,'上海鸡狗对邦'),(781,'PalVerse'),(936,'十周年水彩风')],
 [(71,'8th'),(191,'台湾剧场版前篇特典'),(261,'8th扭蛋吧唧'),(346,'OK COFFEE'),(431,'十周年心吧唧'),(516,'十周年水彩15cm'),(596,'元祖'),(681,'简中版雨中祈晴'),(766,'女仆'),(936,'GIGO福冈')],
 [(21,'上海鸡狗对邦BD(A店/G店)'),(96,'鸡狗对邦2.0'),(171,'冬日旅行75mm'),(361,'冬日旅行'),(431,'ESP贝斯吧唧'),(516,'jr新干线'),(596,'花朵v2'),(681,'花朵v2(15cm)'),(766,'十周年live抽赏'),(936,'鸡狗新咖')],
 [(71,'迷子'),(191,'鸡狗漫画3卷发售纪念'),(261,'鸡狗漫画3卷发售纪念特典'),(361,'2026生日套'),(431,'鸡狗对邦2.0'),(516,'雨中祈晴3卷'),(681,'迷子集会第三弹'),(851,'方吧唧')],
 [(71,'9th'),(191,'R Baker联动'),(261,'OK COFFEE'),(361,'吉祥航空联动'),(516,'吉祥航空联动')],
]


def label_center_col(mille):
    """名称条中心列（1-based，floor）"""
    return int(mille * PX_PER_MILLE / COL_W) + 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--json', default='')
    ap.add_argument('--category', default='吧唧')
    ap.add_argument('--check-grid', default='')
    args = ap.parse_args()

    img = cv2.cvtColor(np.array(Image.open(args.src).convert('RGB')), cv2.COLOR_RGB2BGR)
    h, w = img.shape[:2]
    os.makedirs(args.out_dir, exist_ok=True)

    if args.check_grid:
        vis = img.copy()
        for c in range(COLS + 1):
            cv2.line(vis, (X0 + c * COL_W, 0), (X0 + c * COL_W, h), (0, 0, 255), 2)
        for r in range(ROWS_N + 1):
            cv2.line(vis, (0, ROW_TOP + r * ROW_H), (w, ROW_TOP + r * ROW_H), (0, 0, 255), 2)
        cv2.imwrite(args.check_grid, vis)
        print('grid check saved:', args.check_grid)

    cells = []
    for r in range(1, ROWS_N + 1):
        top = ROW_TOP + (r - 1) * ROW_H
        # 名称中心列表
        labels = [(label_center_col(m), name) for m, name in ROWS[r - 1]]
        lab_map = {c: n for c, n in labels}
        # 行2 特殊：三专致迹拆 3 款
        if r == 2:
            lab_map = {1: '八单限定A/B', 2: '三专致迹(特装)', 3: '三专致迹(限定)', 4: '三专致迹(通常)'}
        last_name = None
        for c in BADGE_COLS[r - 1]:
            name = lab_map.get(c)
            if name is None:
                name = last_name if last_name else '未标注'
            last_name = name
            left = X0 + (c - 1) * COL_W
            cell_img = img[top:top + ROW_H, left:left + COL_W]
            fn = 'r%02dc%02d_v2.jpg' % (r, c)
            cv2.imwrite(os.path.join(args.out_dir, fn), cell_img, [cv2.IMWRITE_JPEG_QUALITY, 88])
            cells.append({'row': r, 'col': c, 'name': name.strip(), 'img': 'assets/soyo_badges/' + fn})
    print('cells:', len(cells))

    seen = {}
    for c in cells:
        seen[c['name']] = seen.get(c['name'], 0) + 1
        c['seq'] = seen[c['name']]
    for c in cells:
        if seen[c['name']] > 1 and c['seq'] > 1:
            c['name'] += '(2)' if c['seq'] == 2 else '(%d)' % c['seq']
        c.pop('seq', None)

    items = [{
        'name': c['name'], 'goods_type': args.category, 'category': args.category, 'series': '', 'release_date': '',
        'price_jpy': 0, 'status': '', 'source': '葉羽图鉴', 'image': c['img'],
        'source_url': '', 'jp_name': ''
    } for c in cells]
    data = {
        'format': 'eatg-gallery-seed', 'version': 1, 'character': '长崎素世',
        'ip': 'MyGO', 'collected_at': '2026-10-15',
        'source_note': '素世吧唧全图鉴（作者葉羽，2026-07-30 版）。固定 12x17 网格整格切割（v2 文件名），一格一谷子；行2 三专致迹拆3款，无名格继承左邻名加序号。',
        'items': items
    }
    if args.json:
        io.open(args.json, 'w', encoding='utf-8', newline='').write(
            json.dumps(data, ensure_ascii=False, indent=1))
        print('JSON saved:', args.json)

    # 核对清单
    with io.open(args.json + '.audit.csv', 'w', encoding='utf-8', newline='') as f:
        f.write('row,col,name\n')
        for c in cells:
            f.write('%d,%d,%s\n' % (c['row'], c['col'], c['name']))
        print('audit csv saved')


if __name__ == '__main__':
    main()
