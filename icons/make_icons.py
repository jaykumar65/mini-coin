"""MNC Miner के PWA आइकन बनाता है (icon-192.png, icon-512.png).

चलाएँ:  python miner-web/icons/make_icons.py
ज़रूरत: Pillow  (pip install pillow)

डिज़ाइन बीच के 80% हिस्से में रखा है, ताकि Android के गोल/maskable
आइकन में कुछ न कटे।
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BG = (20, 22, 28)        # #14161c — पेज का बैकग्राउंड
COIN = (245, 185, 66)    # #f5b942
COIN_DARK = (201, 142, 28)
INK = (27, 20, 0)
TAG_BG = (90, 42, 18)    # बैनर वाला रंग
TAG_TEXT = (255, 217, 184)

FONT = "C:/Windows/Fonts/arialbd.ttf"
OUT = Path(__file__).resolve().parent
SS = 4  # supersampling, किनारे चिकने करने के लिए


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default(size)


def make(size):
    s = size * SS
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)

    cx, cy, r = s / 2, s * 0.42, s * 0.26
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=COIN_DARK)
    r2 = r * 0.88
    d.ellipse((cx - r2, cy - r2, cx + r2, cy + r2), fill=COIN)
    d.text((cx, cy), "M", font=font(int(r * 1.25)), fill=INK, anchor="mm")

    # नीचे "TESTNET" पट्टी
    tw, th = s * 0.44, s * 0.11
    ty = s * 0.76
    d.rounded_rectangle((cx - tw / 2, ty - th / 2, cx + tw / 2, ty + th / 2), radius=th / 2, fill=TAG_BG)
    d.text((cx, ty), "TESTNET", font=font(int(th * 0.62)), fill=TAG_TEXT, anchor="mm")

    img = img.resize((size, size), Image.LANCZOS)
    path = OUT / f"icon-{size}.png"
    img.save(path, optimize=True)
    print(path, img.size)


if __name__ == "__main__":
    for n in (192, 512):
        make(n)
