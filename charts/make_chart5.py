# -*- coding: utf-8 -*-
"""
图 5：速率与并发对 B 类 429 率的影响（生产日志，观测性证据）
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
C_LOW = (120, 165, 205)
C_HIGH = (210, 75, 65)
C_GRID = (228, 230, 234)
C_WARN = (235, 175, 60)


def chart5():
    W, H = 1500, 880
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)
    f_title = get_font(30)
    f_sub = get_font(16)
    f_h = get_font(19)
    f = get_font(15)
    f_num = get_font(14)
    f_big = get_font(17)

    d.text((60, 26), '速率与并发对 B 类 429 率的影响', fill=C_TEXT, font=f_title)
    d.text((60, 66), '数据源：生产日志（近 7 天，sensenova，观测性证据）· 实验只覆盖到 4 次/分钟，此处为实验未及区间的补充', fill=C_MUTED, font=f_sub)

    # ---- 左：按分钟请求数分档 ----
    bars = [
        ('1-3', 36.6, 601), ('4-6', 37.5, 616), ('7-10', 32.9, 499),
        ('11-15', 42.4, 356), ('16-20', 29.8, 208), ('21-30', 27.8, 194),
        ('31-50', 65.1, 126), ('>50', 85.8, 289),
    ]
    lx, rx = 90, 780
    top, bottom = 150, 540
    d.text((lx, 112), '① 按每分钟请求数分档', fill=C_TEXT, font=f_h)

    maxv = 100
    def y_of(v): return bottom - v / maxv * (bottom - top)
    for v in [0, 20, 40, 60, 80, 100]:
        y = y_of(v)
        d.line([(lx, y), (rx, y)], fill=C_GRID, width=1)
        d.text((lx - 42, y - 8), f'{v}%', fill=C_MUTED, font=f_num)

    bw = (rx - lx) / len(bars) * 0.58
    for i, (label, rate, n) in enumerate(bars):
        xc = lx + (i + 0.5) * (rx - lx) / len(bars)
        color = C_HIGH if rate >= 60 else C_LOW
        d.rectangle([xc - bw / 2, y_of(rate), xc + bw / 2, bottom], fill=color)
        d.text((xc - 16, y_of(rate) - 22), f'{rate:.0f}%', fill=C_TEXT, font=f_big)
        d.text((xc - 16, bottom + 10), label, fill=C_TEXT, font=f_num)
        d.text((xc - 22, bottom + 32), f'n={n}', fill=C_MUTED, font=f_num)
    d.line([(lx, bottom), (rx, bottom)], fill=C_TEXT, width=2)
    d.text((lx + 180, bottom + 64), '每分钟请求数', fill=C_TEXT, font=f)
    d.text((lx, bottom + 96), '※ 1–30 区间在 28–42% 波动、无趋势；>30 后跃升至 65–86%', fill=C_WARN, font=f)

    # ---- 右：单发 vs 并发 ----
    sx = 880
    d.text((sx, 112), '② 同一秒内是否并发', fill=C_TEXT, font=f_h)
    pairs = [('单发', '每秒 1 个', 33.6, 1969, C_LOW), ('并发', '每秒 ≥2 个', 59.9, 920, C_HIGH)]
    sbw = 150
    for i, (label, sub, rate, n, color) in enumerate(pairs):
        xc = sx + 140 + i * 260
        d.rectangle([xc - sbw / 2, y_of(rate), xc + sbw / 2, bottom], fill=color)
        d.text((xc - 24, y_of(rate) - 26), f'{rate:.1f}%', fill=C_TEXT, font=f_big)
        d.text((xc - 20, bottom + 10), label, fill=C_TEXT, font=f)
        d.text((xc - 36, bottom + 32), sub, fill=C_MUTED, font=f_num)
        d.text((xc - 26, bottom + 54), f'n={n}', fill=C_MUTED, font=f_num)
    d.line([(sx, bottom), (sx + 520, bottom)], fill=C_TEXT, width=2)
    d.text((sx, bottom + 96), '※ 并发时为单发的 1.8 倍', fill=C_WARN, font=f)

    # 底部结论（下移，不再遮挡）
    d.rounded_rectangle([60, 760, W - 60, 845], radius=8, fill=(252, 246, 232), outline=(230, 205, 150))
    d.text((82, 774), '结论', fill=C_WARN, font=f_h)
    d.text((82, 806), '低速率（≤4 次/分钟）下速率不显著；但 >30 次/分钟或存在秒级并发时，429 率显著上升。', fill=C_TEXT, font=f)

    out = os.path.join(HERE, 'chart5-rate-and-concurrency.png')
    img.save(out)
    return out


print('gen:', chart5())
