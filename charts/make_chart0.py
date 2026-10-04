# -*- coding: utf-8 -*-
"""
图 0：四个候选解释的排除逻辑图
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))


def get_font(size):
    for name in ['msyh.ttc', 'simhei.ttf', 'simsun.ttc', 'arial.ttf']:
        for base in ['C:/Windows/Fonts', '/usr/share/fonts/truetype']:
            p = os.path.join(base, name)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    pass
    return ImageFont.load_default()


C_TEXT = (35, 39, 47)
C_MUTED = (115, 121, 130)
C_REJECT = (200, 70, 60)
C_KEEP = (60, 150, 110)
C_BOX = (246, 247, 249)
C_BORDER = (215, 218, 223)


def chart0():
    W, H = 1500, 900
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)
    f_title = get_font(32)
    f_sub = get_font(17)
    f_h = get_font(21)
    f = get_font(16)
    f_sm = get_font(14)
    f_big = get_font(24)

    d.text((70, 30), '四个候选解释与排除过程', fill=C_TEXT, font=f_title)
    d.text((70, 74), '面对频繁 429，先列出所有可能的解释，再逐一用实验排除', fill=C_MUTED, font=f_sub)

    # 起始问题
    d.rounded_rectangle([70, 116, W - 70, 172], radius=8, fill=(238, 242, 248), outline=C_BORDER)
    d.text((92, 130), '问题：SenseNova 免费 Token Plan 为何频繁返回 429？', fill=C_TEXT, font=f_h)

    rows = [
        ('H1', '套餐额度用完',
         'A 类 entitlement 报错 0 次；积分池峰值仅 12.5%（另一次 19% 就已频繁 429）',
         '排除', C_REJECT),
        ('H2', '请求次数超限',
         '单模型单窗口跑到 390 次成功请求，次数墙一次未触发',
         '排除', C_REJECT),
        ('H3', '本地速率 / 输入量过大',
         '2×2 析因（1vs4 rpm × 90vs8000 tok）四组无显著差异；TPM 拉到 29000/分钟，832 次零 429',
         '排除', C_REJECT),
        ('H4', '上游侧状态（时段负载）',
         '时段差异 13 倍（深夜 3.4% → 傍晚 43.3%）；十分钟内突发 255 次；模型间 2.4 倍差异',
         '剩余', C_KEEP),
    ]

    y = 200
    for tag, name, evidence, verdict, color in rows:
        h_box = 128
        d.rounded_rectangle([70, y, W - 70, y + h_box], radius=8, fill=C_BOX, outline=C_BORDER)
        # 左侧标签
        d.rounded_rectangle([70, y, 148, y + h_box], radius=8, fill=color)
        d.text((92, y + 46), tag, fill='white', font=f_big)
        # 假设名
        d.text((172, y + 18), name, fill=C_TEXT, font=f_h)
        # 证据
        d.text((172, y + 54), '证据：', fill=C_MUTED, font=f_sm)
        d.text((228, y + 54), evidence, fill=C_TEXT, font=f)
        # 判定
        d.text((172, y + 88), '判定：', fill=C_MUTED, font=f_sm)
        d.text((228, y + 86), verdict, fill=color, font=f_h)
        y += h_box + 14

    # 结论
    d.rounded_rectangle([70, y + 6, W - 70, y + 96], radius=8, fill=(236, 246, 240), outline=(180, 215, 195))
    d.text((92, y + 20), '结论', fill=C_KEEP, font=f_h)
    d.text((92, y + 54), '排除前三项后，只剩「上游侧状态」——429 的触发条件取决于上游在那一刻的状态，而非本地请求特征。',
           fill=C_TEXT, font=f)

    out = os.path.join(HERE, 'chart0-elimination-logic.png')
    img.save(out)
    return out


print('gen:', chart0())
