# -*- coding: utf-8 -*-
"""一咕 · 图鉴网格切格工具（素世吧唧全图鉴等「一格一徽章」总览图 → 图鉴种子）

用法：
  python tools/cut_badge_gallery.py --src <新版图路径> --out-dir <输出目录> [--json <种子json路径>]

流程（未来更新图时重跑）：
  1. 用 Read 读新图 → 目测/OCR 得到每行徽章名称标签的 y 位置（千分比）→ 更新下方 LABEL_Y 与 ROWS
  2. 跑本脚本：按 OCR 名称分列切格 → 输出 app/assets/soyo_badges/rXXcXX.jpg + 种子 JSON
  3. 生成的种子 JSON 在图鉴页「导」导入：同名跳过（不覆盖已点亮/关联谷子），新增款自动补

约束：
  - 版式固定 13 列等分（x0=20, 格宽 135）、行高 132（与葉羽图鉴版式一致）；新版式需同步调整常量
  - 重名款自动加 (2) 后缀（避免导入同名合并丢款）
"""
import argparse, cv2, numpy as np, os, json, io

X0, COL_W, COLS, ROW_H = 20, 135, 13, 132
# 每行标签 y（千分比）——新图需重新目测校准
LABEL_Y = [62,122,172,227,292,342,392,442,492,542,592,642,692,742,792,842,902,962]
# 每行名称表：(x_千分比, 名称) ——新图需重新整理
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

def col_of(x_permil, w):
    px = x_permil * w / 1000
    idx = round((px - X0) / COL_W)
    return max(0, min(COLS - 1, idx))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--json', default='')
    args = ap.parse_args()

    img = cv2.imread(args.src, cv2.IMREAD_UNCHANGED)[:, :, :3]
    h, w = img.shape[:2]
    row_top = [int(y * h / 1000) - 66 for y in LABEL_Y]
    col_left = [X0 + i * COL_W for i in range(COLS)]
    os.makedirs(args.out_dir, exist_ok=True)

    cells = []
    for r, tags in enumerate(ROWS, 1):
        for x_permil, name in tags:
            c = col_of(x_permil, w)
            top, left = row_top[r - 1], col_left[c]
            cell_img = img[top:top + ROW_H, left:left + COL_W]
            fn = 'r%02dc%02d.jpg' % (r, c + 1)
            cv2.imwrite(os.path.join(args.out_dir, fn), cell_img, [cv2.IMWRITE_JPEG_QUALITY, 88])
            cells.append({'row': r, 'col': c + 1, 'name': name.strip(), 'img': 'assets/soyo_badges/' + fn})
    print('cells:', len(cells))

    if args.json:
        seen = {}
        for c in cells:
            seen[c['name']] = seen.get(c['name'], 0) + 1
            c['seq'] = seen[c['name']]
        for c in cells:
            if seen[c['name']] > 1 and c['seq'] > 1:
                c['name'] += '(2)'
            c.pop('seq', None)
        items = [{
            'name': c['name'], 'goods_type': '吧唧', 'category': '吧唧', 'series': '', 'release_date': '',
            'price_jpy': 0, 'status': '', 'source': '葉羽图鉴', 'image': c['img'],
            'source_url': '', 'jp_name': ''
        } for c in cells]
        data = {
            'format': 'eatg-gallery-seed', 'version': 1, 'character': '长崎素世',
            'ip': 'MyGO', 'collected_at': '2026-10-15',
            'source_note': '素世吧唧全图鉴（作者葉羽，2026-07-30 版）。按图内网格逐格切图，名称取自图内标签。',
            'items': items
        }
        io.open(args.json, 'w', encoding='utf-8', newline='').write(
            json.dumps(data, ensure_ascii=False, indent=1))
        print('JSON saved:', args.json)

if __name__ == '__main__':
    main()
