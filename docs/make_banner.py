#!/usr/bin/env python3
"""Draw the repo banner. Pure PIL, no generated imagery — RyanAI Lab house style.

Concept: three opt-in knobs (tools=minimal, tools_mode=ptc, fanout) as three
switches; only one is lit (the recommended one). Left = wordmark. Right = three
stacked switch slabs, 01/02/03 annotations, a single orange indicator on 01
(the unambiguous win) and dim indicators on 02/03 (the net losses).

Dependencies: Pillow is the only third-party package — `pip install Pillow`.
Fonts fall back to PIL's default bitmap font if the macOS system fonts below
are not found, so the script still runs on a machine without them.
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 640
BG = (10, 10, 10)
WHITE = (245, 245, 245)
GREY = (140, 140, 140)
DIM = (70, 70, 70)
ORANGE = (255, 122, 26)
OUT = pathlib.Path(__file__).resolve().parents[1] / "docs/assets/banner.png"

HN = "/System/Library/Fonts/HelveticaNeue.ttc"
MENLO = "/System/Library/Fonts/Menlo.ttc"

def font(path, size, index=0):
    try:
        return ImageFont.truetype(path, size, index=index)
    except Exception:
        return ImageFont.load_default()

f_title = font(HN, 88, 7)     # Light
f_tag = font(HN, 30, 7)
f_mono = font(MENLO, 17)
f_label = font(MENLO, 15)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# crosshair corners
for cx, cy in ((40, 40), (W - 40, H - 40)):
    d.line([(cx - 11, cy), (cx + 11, cy)], fill=DIM, width=1)
    d.line([(cx, cy - 11), (cx, cy + 11)], fill=DIM, width=1)

# 5x3 dot lattices
for ox, oy in ((72, 78), (1150, 536)):
    for r in range(3):
        for c in range(5):
            x, y = ox + c * 15, oy + r * 12
            d.ellipse([x, y, x + 1.6, y + 1.6], fill=DIM)

# wordmark
d.text((80, 196), "DSH KNOBS", font=f_title, fill=WHITE)
d.text((80, 288), "MEASURED", font=f_title, fill=WHITE)
d.text((82, 414), "Three opt-in levers on two Dell Pro Max with GB10.", font=f_tag, fill=WHITE)
d.text((82, 462), "DEEPSEEK HARNESS · tools · tools_mode · fanout · ONE WIN, TWO NET LOSSES", font=f_mono, fill=GREY)

# right: three knobs as slabs (isometric-ish parallelograms), stacked
SX, SY = 860, 150
knobs = [("tools=MINIMAL", "01"), ("tools_mode=PTC", "02"), ("fanout", "03")]
slab_w, slab_h, skew, gap = 260, 58, 42, 52
boxes = []
for i, (name, num) in enumerate(knobs):
    y = SY + i * (slab_h + gap)
    poly = [(SX + skew, y), (SX + skew + slab_w, y), (SX + slab_w, y + slab_h), (SX, y + slab_h)]
    d.polygon(poly, outline=(96, 96, 96), width=1)
    d.text((SX + skew + 14, y + 18), name, font=f_label, fill=GREY)
    d.text((SX + skew + slab_w + 16, y + 20), num, font=f_label, fill=DIM)
    boxes.append(y)

# indicators: orange dot on 01 (the win), dim dots on 02/03 (the losses)
ix = SX + skew + slab_w - 30
for i, y in enumerate(boxes):
    cy = y + slab_h // 2
    fill = ORANGE if i == 0 else DIM
    d.ellipse([ix - 5, cy - 5, ix + 5, cy + 5], fill=fill)
d.text((ix + 14, boxes[0] + slab_h // 2 - 8), "WIN", font=f_label, fill=ORANGE)

# dashed down-flow linking the three knobs
def dashed(p0, p1, dash=6, gap_=6, fill=DIM):
    x0, y0 = p0; x1, y1 = p1
    L = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
    n = int(L // (dash + gap_))
    for k in range(n):
        t0 = k * (dash + gap_) / L; t1 = (k * (dash + gap_) + dash) / L
        d.line([(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0), (x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)], fill=fill, width=1)

lx = SX + 20
dashed((lx, boxes[0] + slab_h), (lx, boxes[1]))
dashed((lx, boxes[1] + slab_h), (lx, boxes[2]))
d.text((lx - 70, boxes[1] - 30), "opt-in", font=f_label, fill=DIM)

# footer rule + labels
d.line([(80, 560), (W - 80, 560)], fill=(40, 40, 40), width=1)
d.text((80, 576), "RYANAI LAB", font=f_label, fill=GREY)
d.text((W - 80 - 250, 576), "DELL PRO MAX WITH GB10", font=f_label, fill=GREY)

OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT)
print("wrote", OUT)
