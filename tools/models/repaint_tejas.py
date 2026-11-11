"""
tools/models/repaint_tejas.py - repaint the source Tejas texture from its prototype camouflage to
the IAF air-superiority grey, keeping panel lines, rivets, grime and every marking.

The camouflage is six flat colours. Each pixel is fitted as a shaded camouflage colour (k * c) or a
blend of two of them (antialiased patch edges); where that fit is close, the pixel is repainted as
k * GREY (so lines and shading survive). Markings, metal, glass, tyres etc. don't fit and are kept.

Usage: python -I repaint_tejas.py <in baseColor.png> <out.png> [size]
"""
import sys

import numpy as np
from PIL import Image

# The source's camouflage colours (sRGB), measured from the texture's histogram.
CAMO = np.array([
    (56, 50, 38),     # dark brown
    (86, 79, 60),     # olive
    (149, 139, 90),   # sand
    (153, 97, 80),    # light red-brown
    (104, 62, 50),    # dark red-brown
    (177, 188, 171),  # pale grey-green spots
], dtype=np.float32) / 255.0

# Target paint (sRGB): the same light grey the procedural model uses (linear 0.52/0.56/0.595).
GREY = np.array([190, 197, 203], dtype=np.float32) / 255.0
# Residual (sRGB units) under which a pixel counts as camouflage, and the soft band above it.
FIT_IN = 0.035
FIT_OUT = 0.07


def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    img = Image.open(src).convert('RGB')
    if size:
        img = img.resize((size, size), Image.LANCZOS)
    p = np.asarray(img, dtype=np.float32) / 255.0
    h, w, _ = p.shape
    flat = to_lin(p.reshape(-1, 3))
    camo = to_lin(CAMO)

    best_res = np.full(flat.shape[0], np.inf, dtype=np.float32)
    best_k = np.zeros(flat.shape[0], dtype=np.float32)
    # Shaded single colours: p = k c, k = (p.c)/(c.c).
    for c in camo:
        k = np.clip(flat @ c / (c @ c), 0.0, 1.6)
        res = np.linalg.norm(flat - k[:, None] * c, axis=1)
        better = res < best_res
        best_res[better] = res[better]
        best_k[better] = k[better]
    # Edge blends of two colours (unshaded): p = c_i + t (c_j - c_i), t in [0, 1]. These are plain
    # paint (k = 1); preferring them over a shaded single colour stops patch outlines ghosting through.
    lum_w = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    pair_res = np.full(flat.shape[0], np.inf, dtype=np.float32)
    for i in range(len(camo)):
        for j in range(i + 1, len(camo)):
            a, b = camo[i], camo[j]
            d = b - a
            t = np.clip((flat - a) @ d / (d @ d), 0.0, 1.0)
            q = a + t[:, None] * d
            pair_res = np.minimum(pair_res, np.linalg.norm(flat - q, axis=1))
    use_pair = pair_res <= best_res * 1.5 + 0.004
    best_res = np.where(use_pair, np.minimum(pair_res, best_res), best_res)
    best_k = np.where(use_pair, 1.0, best_k)
    # Slight shading (|k - 1| < 0.15) is camouflage texture noise, not panel lines: paint it flat.
    best_k = np.where(np.abs(best_k - 1.0) < 0.15, 1.0, best_k)
    # Residual measured in sRGB-ish units so dark and light areas are judged alike.
    res_s = best_res / np.maximum(flat @ lum_w, 0.02) ** 0.5 * 0.25
    wgt = np.clip((FIT_OUT - res_s) / (FIT_OUT - FIT_IN), 0.0, 1.0)[:, None]
    grey = to_lin(GREY)
    repainted = best_k[:, None] * grey
    outp = wgt * repainted + (1.0 - wgt) * flat
    Image.fromarray((to_srgb(outp).reshape(h, w, 3) * 255.0 + 0.5).astype(np.uint8)).save(out)
    print(f'repainted {float((wgt > 0.5).mean()) * 100:.1f}% of pixels -> {out}')


if __name__ == '__main__':
    main()
