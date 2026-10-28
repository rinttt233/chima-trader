"""ChimaTrader icon concept: 天弓 · 归零 (Tenkyuu · Void).

Rainbow bow (天弓) over a market: a golden candlestick falls into a black void
ringed with gold, with a zero in the event horizon. Dark ink background.
"""
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

S = 2048                    # supersampled canvas
OUT = 1024                  # final size for preview/master

BASE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(BASE, "out"), exist_ok=True)

INK_CENTER = (20, 30, 48)
INK_EDGE = (6, 8, 14)
GOLD = (240, 190, 90)
GOLD_LIGHT = (255, 220, 150)
RAINBOW = [
    (255, 92, 97),   # vermilion
    (245, 185, 66),  # amber
    (61, 220, 151),  # jade
    (74, 168, 255),  # azure
    (167, 139, 250), # violet
]


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def radial_background(size):
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    cx = cy = size / 2.0
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (size * 0.72)
    dist = np.clip(dist, 0, 1)[..., None]
    center = np.array(INK_CENTER, dtype=np.float32)
    edge = np.array(INK_EDGE, dtype=np.float32)
    rgb = center * (1 - dist) + edge * dist
    alpha = np.full((size, size, 1), 255, dtype=np.float32)
    return Image.fromarray(np.concatenate([rgb, alpha], axis=2).astype(np.uint8), "RGBA")


def add_grid(img, size):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    step = size // 16
    for i in range(1, 16):
        p = i * step
        d.line([(p, 0), (p, size)], fill=(120, 160, 220, 12), width=2)
        d.line([(0, p), (size, p)], fill=(120, 160, 220, 12), width=2)
    # subtle market glow near the top third
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((size * 0.28, -size * 0.18, size * 0.72, size * 0.42),
               fill=(64, 120, 230, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.10))
    img.alpha_composite(glow)
    img.alpha_composite(layer)
    return img


def draw_rainbow_bow(img, size):
    """Five concentric bands forming a rainbow bow, with strings and glow."""
    cx, cy = size / 2.0, size * 0.615
    radius = size * 0.355
    start, end = 200, 340
    band_width = size * 0.018
    gap = size * 0.004
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i, color in enumerate(RAINBOW):
        r = radius - gap * (len(RAINBOW) // 2 - i)
        gd.arc((cx - r, cy - r, cx + r, cy + r), start=start, end=end,
               fill=color + (150,), width=int(band_width))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.018))
    img.alpha_composite(glow)

    d = ImageDraw.Draw(img)
    for i, color in enumerate(RAINBOW):
        r = radius - gap * (len(RAINBOW) // 2 - i)
        d.arc((cx - r, cy - r, cx + r, cy + r), start=start, end=end,
              fill=color + (255,), width=int(band_width))

    # rounded end caps
    for i, color in enumerate(RAINBOW):
        r = radius - gap * (len(RAINBOW) // 2 - i)
        for ang in (start, end):
            a = math.radians(ang)
            ex, ey = cx + r * math.cos(a), cy + r * math.sin(a)
            cap_r = band_width / 2
            d.ellipse((ex - cap_r, ey - cap_r, ex + cap_r, ey + cap_r), fill=color + (255,))
    p1 = (cx + radius * math.cos(math.radians(start)), cy + radius * math.sin(math.radians(start)))
    p2 = (cx + radius * math.cos(math.radians(end)), cy + radius * math.sin(math.radians(end)))
    return p1, p2


def draw_void(img, size):
    """Black hole / 归零: colored accretion halo, gold ring, slashed zero."""
    cx, cy = size / 2.0, size * 0.800
    r_outer = size * 0.190
    r_ring = size * 0.182

    # colored accretion halo: makes the void read as a hole, not a flat circle
    acc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(acc)
    for rr, col, alpha, width in [
        (r_ring * 1.10, (167, 139, 250), 150, size * 0.030),
        (r_ring * 1.02, (74, 168, 255), 130, size * 0.018),
        (r_ring * 1.02, (245, 185, 66), 110, size * 0.010),
    ]:
        ad.ellipse((cx - rr, cy - rr, cx + rr, cy + rr),
                   outline=col + (alpha,), width=int(width))
    acc = acc.filter(ImageFilter.GaussianBlur(size * 0.045))
    img.alpha_composite(acc)

    # soft dark halo (event horizon glow)
    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse((cx - r_outer * 1.6, cy - r_outer * 1.6, cx + r_outer * 1.6, cy + r_outer * 1.6),
               fill=(0, 0, 0, 235))
    halo = halo.filter(ImageFilter.GaussianBlur(size * 0.060))
    img.alpha_composite(halo)

    # event horizon with radial falloff
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / r_outer
    hole_alpha = np.clip(1.0 - dist, 0, 1) ** 0.45
    hole_alpha = (hole_alpha * 255 * 0.99).astype(np.uint8)
    hole = np.zeros((size, size, 4), dtype=np.uint8)
    hole[..., 0:3] = 2
    hole[..., 3] = hole_alpha
    img.alpha_composite(Image.fromarray(hole, "RGBA"))

    # thin gold event-horizon ring
    ring = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    w = size * 0.015
    rd.ellipse((cx - r_ring, cy - r_ring, cx + r_ring, cy + r_ring),
               outline=GOLD + (240,), width=int(w))
    ring_glow = ring.filter(ImageFilter.GaussianBlur(size * 0.020))
    img.alpha_composite(ring_glow)
    img.alpha_composite(ring)

    # 归零: slashed zero in the hole
    zero = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    zd = ImageDraw.Draw(zero)
    zr = r_ring * 0.48
    zx, zy = cx, cy
    zw = size * 0.022
    zd.ellipse((zx - zr * 0.62, zy - zr, zx + zr * 0.62, zy + zr),
               outline=GOLD_LIGHT + (235,), width=int(zw))
    slash_pad = zr * 0.90
    zd.line([(zx - slash_pad * 0.62, zy - slash_pad), (zx + slash_pad * 0.62, zy + slash_pad)],
            fill=GOLD_LIGHT + (235,), width=int(zw * 0.85))
    zero_glow = zero.filter(ImageFilter.GaussianBlur(size * 0.006))
    img.alpha_composite(zero_glow)
    img.alpha_composite(zero)
    return cx, cy, r_outer


def draw_falling_candle(img, size, void_center):
    """A golden candlestick whose lower wick is swallowed by the void."""
    cx = size / 2.0
    vx, vy, vr = void_center
    top = size * 0.315
    body_top = size * 0.405
    body_bottom = size * 0.600
    body_w = size * 0.075
    wick_w = size * 0.010

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # wick
    d.rounded_rectangle((cx - wick_w / 2, top, cx + wick_w / 2, body_top),
                        radius=wick_w / 2, fill=GOLD_LIGHT + (255,))
    d.rounded_rectangle((cx - wick_w / 2, body_bottom, cx + wick_w / 2, vy - vr * 0.58),
                        radius=wick_w / 2, fill=GOLD + (255,))
    # candle body (gold) with a soft top-light
    body = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle((cx - body_w / 2, body_top, cx + body_w / 2, body_bottom),
                         radius=body_w * 0.16, fill=GOLD + (255,))
    light = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ld = ImageDraw.Draw(light)
    ld.rounded_rectangle((cx - body_w / 2, body_top, cx + body_w / 2,
                          body_top + (body_bottom - body_top) * 0.45),
                         radius=body_w * 0.16, fill=GOLD_LIGHT + (110,))
    body.alpha_composite(light)
    layer.alpha_composite(body)
    # glow
    glow = layer.filter(ImageFilter.GaussianBlur(size * 0.012))
    img.alpha_composite(glow)
    img.alpha_composite(layer)

    # fade the bottom of the candle into the void
    fade = Image.new("L", (size, size), 0)
    fd = ImageDraw.Draw(fade)
    fade_top = int(vy - vr * 0.75)
    for y in range(fade_top, size):
        t = (y - fade_top) / max(1, size - fade_top)
        fd.line([(0, y), (size, y)], fill=int(255 * max(0.0, 1.0 - t * 1.6)))
    fade = fade.filter(ImageFilter.GaussianBlur(size * 0.01))
    # mask only around the candle area
    region = Image.new("L", (size, size), 0)
    ImgDraw = ImageDraw.Draw(region)
    ImgDraw.rectangle((cx - size * 0.2, fade_top, cx + size * 0.2, size), fill=255)
    region = region.filter(ImageFilter.GaussianBlur(size * 0.02))
    fade = Image.composite(fade, Image.new("L", (size, size), 0), region)
    # apply: lighten the canvas's candle pixels by dest-out? Instead draw void over again partially.
    # Simpler: draw black over the lower candle with alpha from fade.
    black = Image.new("RGBA", (size, size), (2, 3, 6, 0))
    black.putalpha(fade.point(lambda v: int(v * 0.92)))
    img.alpha_composite(black)


def draw_particles(img, size, void_center):
    cx, cy, vr = void_center
    rnd = random.Random(20261029)
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for _ in range(110):
        a = rnd.uniform(0, math.tau)
        r = vr * rnd.uniform(1.15, 2.3)
        x = cx + math.cos(a) * r
        y = cy + math.sin(a) * r * 0.72
        if y > size * 0.98 or y < size * 0.5:
            continue
        size_px = size * rnd.uniform(0.0025, 0.0075)
        alpha = int(rnd.uniform(40, 150) * max(0.25, 1 - (r / (vr * 2.4))))
        color = GOLD_LIGHT if rnd.random() < 0.7 else RAINBOW[rnd.randrange(len(RAINBOW))]
        d.ellipse((x - size_px, y - size_px, x + size_px, y + size_px), fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(size * 0.0025))
    img.alpha_composite(layer)


def render(size=S, with_bg=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if with_bg:
        img.alpha_composite(radial_background(size))
        img = add_grid(img, size)
    p1, p2 = draw_rainbow_bow(img, size)
    void_center = draw_void(img, size)
    draw_falling_candle(img, size, void_center)
    draw_particles(img, size, void_center)
    return img


def render_background(size=S):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img.alpha_composite(radial_background(size))
    return add_grid(img, size)


ANDROID_LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ANDROID_ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
WEB_ICONS = {"favicon-32.png": 32, "favicon-180.png": 180, "icon-192.png": 192, "icon-512.png": 512}


def main():
    root = os.path.abspath(os.path.join(BASE, "..", ".."))
    if os.path.basename(BASE) == "icon":
        root = os.path.abspath(os.path.join(BASE, "..", ".."))
    android_res = os.path.join(root, "android", "app", "src", "main", "res")
    public_dir = os.path.join(root, "public")
    docs_dir = os.path.join(root, "docs")
    os.makedirs(docs_dir, exist_ok=True)

    master = render()
    # rounded-square legacy icon and circular icon
    legacy_full = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    legacy_full.alpha_composite(master)
    legacy_full.putalpha(rounded_mask(S, int(S * 0.22)))
    round_full = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    round_full.alpha_composite(master)
    round_mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(round_mask).ellipse((0, 0, S - 1, S - 1), fill=255)
    round_full.putalpha(round_mask)

    # adaptive: full-bleed background + foreground fitted into the safe-ish area
    bg_full = render_background()
    design = render(with_bg=False)
    fg_full = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bbox = design.getbbox()
    cropped = design.crop(bbox) if bbox else design
    target = int(S * 0.88)
    scale = target / max(cropped.width, cropped.height)
    scaled = cropped.resize(
        (max(1, int(cropped.width * scale)), max(1, int(cropped.height * scale))),
        Image.LANCZOS,
    )
    fg_full.alpha_composite(scaled, ((S - scaled.width) // 2, (S - scaled.height) // 2))

    for density, size in ANDROID_LEGACY.items():
        d = os.path.join(android_res, f"mipmap-{density}")
        os.makedirs(d, exist_ok=True)
        legacy_full.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))
        round_full.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher_round.png"))

    for density, size in ANDROID_ADAPTIVE.items():
        d = os.path.join(android_res, f"mipmap-{density}")
        fg_full.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher_foreground.png"))
        bg_full.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher_background.png"))

    # docs: 1024 master + round preview
    legacy_full.resize((OUT, OUT), Image.LANCZOS).save(os.path.join(docs_dir, "icon.png"))
    round_full.resize((OUT, OUT), Image.LANCZOS).save(os.path.join(docs_dir, "icon-round.png"))

    # web icons
    os.makedirs(public_dir, exist_ok=True)
    for name, size in WEB_ICONS.items():
        legacy_full.resize((size, size), Image.LANCZOS).save(os.path.join(public_dir, name))
    legacy_full.resize((60, 60), Image.LANCZOS).save(os.path.join(public_dir, "brand-mark.png"))

    manifest = {
        "name": "千亦所 ChimaTrader",
        "short_name": "千亦所",
        "description": "本地多市场模拟交易终端（行情真实、资金虚拟）",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": "#0b0e13",
        "theme_color": "#0b0e13",
        "icons": [
            {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        ],
    }
    import json
    with open(os.path.join(public_dir, "manifest.webmanifest"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("icons written:")
    print("  android res:", android_res)
    print("  web:", ", ".join(WEB_ICONS.keys()))
    print("  docs/icon.png, docs/icon-round.png")


if __name__ == "__main__":
    main()
