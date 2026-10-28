"""ChimaTrader icon generator: 千亦 patchwork + masked red/green candles.

Run:  python tools/icon/make-icons.py
Deps: Pillow (build-time only). Writes Android mipmaps, web favicons/PWA,
Windows .ico, docs previews. Does not touch runtime code.
"""
import os

from PIL import Image, ImageDraw, ImageFilter

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(BASE, "..", ".."))
S = 2048          # supersampled working size
FINAL = 1024

# Chimata Tenkyuu palette (Touhou 18): deep-blue hair, rainbow patchwork dress,
# white cape, golden zipper/cords. Candle colours follow the app's chart:
# red = up, green = down (Chinese convention).
INDIGO_DARK = (14, 21, 38)
CRIMSON = (186, 58, 58)
AMBER = (222, 164, 62)
VIRIDIAN = (47, 133, 102)
ROYAL = (51, 94, 178)
GOLD = (231, 193, 90)
GOLD_LIGHT = (250, 220, 140)
UP = (246, 70, 93)
DOWN = (22, 199, 132)

CANDLES = [
    (0.345, 0.500, 0.650, 0.080, False),  # green
    (0.500, 0.395, 0.690, 0.094, True),   # red, tallest
    (0.655, 0.455, 0.635, 0.080, True),   # red
]

ANDROID_LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ANDROID_ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
WEB_PNGS = {"favicon-32.png": 32, "favicon-180.png": 180, "icon-192.png": 192, "icon-512.png": 512}
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def rounded(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def patchwork_bg():
    bg = Image.new("RGBA", (S, S), INDIGO_DARK + (255,))
    d = ImageDraw.Draw(bg)
    c = (S * 0.5, S * 0.5)
    corners = [(0, 0), (S, 0), (S, S), (0, S)]
    colors = [CRIMSON, ROYAL, AMBER, VIRIDIAN]
    for i in range(4):
        d.polygon([corners[i], corners[(i + 1) % 4], c], fill=colors[i] + (255,))
    for p in corners:
        d.line([c, p], fill=GOLD + (235,), width=int(S * 0.009))
    for p in corners:
        for t in (0.22, 0.42, 0.62):
            x = c[0] + (p[0] - c[0]) * t
            y = c[1] + (p[1] - c[1]) * t
            r = S * 0.011
            d.line([(x - r, y - r), (x + r, y + r)], fill=GOLD_LIGHT + (220,), width=int(S * 0.004))
            d.line([(x - r, y + r), (x + r, y - r)], fill=GOLD_LIGHT + (220,), width=int(S * 0.004))
    return bg


def chart_mask(bg):
    mw, mh = S * 0.68, S * 0.52
    mx, my = (S - mw) / 2, S * 0.55 - mh / 2
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((mx, my, mx + mw, my + mh), radius=S * 0.055, fill=(8, 12, 20, 190))
    layer = layer.filter(ImageFilter.GaussianBlur(S * 0.006))
    bg.alpha_composite(layer)
    rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.rounded_rectangle((mx, my, mx + mw, my + mh), radius=S * 0.055,
                         outline=GOLD + (110,), width=int(S * 0.0035))
    rim = rim.filter(ImageFilter.GaussianBlur(S * 0.0015))
    bg.alpha_composite(rim)
    return bg


def draw_candles(img, specs=CANDLES):
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for cxr, top, bottom, wr, up in specs:
        cx = S * cxr
        w = S * wr
        sd.rounded_rectangle((cx - w / 2 + S * 0.008, S * top + S * 0.012,
                              cx + w / 2 + S * 0.008, S * bottom + S * 0.012),
                             radius=w * 0.18, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.012))
    img.alpha_composite(shadow)

    for cxr, top, bottom, wr, up in specs:
        cx = S * cxr
        w = S * wr
        color = UP if up else DOWN
        d = ImageDraw.Draw(img)
        wick = S * 0.0085
        d.rounded_rectangle((cx - wick / 2, S * top - S * 0.065, cx + wick / 2, S * top + S * 0.008),
                            radius=wick / 2, fill=color + (255,))
        d.rounded_rectangle((cx - wick / 2, S * bottom - S * 0.008, cx + wick / 2, S * bottom + S * 0.065),
                            radius=wick / 2, fill=color + (255,))
        d.rounded_rectangle((cx - w / 2, S * top, cx + w / 2, S * bottom),
                            radius=w * 0.14, fill=color + (255,))
        hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        hd = ImageDraw.Draw(hl)
        hd.rounded_rectangle((cx - w / 2, S * top, cx + w / 2,
                              S * top + (S * bottom - S * top) * 0.32),
                             radius=w * 0.14, fill=(255, 255, 255, 38))
        img.alpha_composite(hl)
    return img


def render_legacy():
    img = patchwork_bg()
    img = chart_mask(img)
    img = draw_candles(img)
    img.putalpha(rounded(S, int(S * 0.22)))
    return img


def render_round():
    img = patchwork_bg()
    img = chart_mask(img)
    img = draw_candles(img)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, S - 1, S - 1), fill=255)
    img.putalpha(mask)
    return img


def render_adaptive_fg():
    fg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fg = chart_mask(fg)
    fg = draw_candles(fg)
    bbox = fg.getbbox()
    cropped = fg.crop(bbox)
    target = int(S * 0.86)
    scale = target / max(cropped.width, cropped.height)
    scaled = cropped.resize((int(cropped.width * scale), int(cropped.height * scale)), Image.LANCZOS)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.alpha_composite(scaled, ((S - scaled.width) // 2, (S - scaled.height) // 2))
    return out


def export():
    android_res = os.path.join(ROOT, "android", "app", "src", "main", "res")
    public_dir = os.path.join(ROOT, "public")
    docs_dir = os.path.join(ROOT, "docs")
    os.makedirs(docs_dir, exist_ok=True)

    legacy = render_legacy()
    round_icon = render_round()
    fg = render_adaptive_fg()
    bg = patchwork_bg()

    for density, size in ANDROID_LEGACY.items():
        d = os.path.join(android_res, f"mipmap-{density}")
        os.makedirs(d, exist_ok=True)
        legacy.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher.png"))
        round_icon.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher_round.png"))
    for density, size in ANDROID_ADAPTIVE.items():
        d = os.path.join(android_res, f"mipmap-{density}")
        fg.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher_foreground.png"))
        bg.resize((size, size), Image.LANCZOS).save(os.path.join(d, "ic_launcher_background.png"))

    legacy.resize((FINAL, FINAL), Image.LANCZOS).save(os.path.join(docs_dir, "icon.png"))
    round_icon.resize((FINAL, FINAL), Image.LANCZOS).save(os.path.join(docs_dir, "icon-round.png"))

    for name, size in WEB_PNGS.items():
        legacy.resize((size, size), Image.LANCZOS).save(os.path.join(public_dir, name))
    legacy.resize((60, 60), Image.LANCZOS).save(os.path.join(public_dir, "brand-mark.png"))

    # Windows / browser .ico (multi-size)
    ico_sizes = [(s, s) for s in ICO_SIZES]
    legacy.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "chima-trader.ico"),
                                                  format="ICO", sizes=ico_sizes)
    legacy.resize((64, 64), Image.LANCZOS).save(os.path.join(public_dir, "favicon.ico"),
                                                format="ICO", sizes=ico_sizes)
    print("icons written to android res, public, docs and chima-trader.ico")


if __name__ == "__main__":
    export()
