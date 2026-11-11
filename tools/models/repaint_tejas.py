"""
tools/models/repaint_tejas.py - repaint the source Tejas texture from its prototype camouflage to
the IAF Tejas's blue-grey, keeping panel lines, rivets, grime and every marking.

The camouflage is six flat colours. Each pixel is fitted as a shaded camouflage colour (k * c) or a
blend of two of them (antialiased patch edges); where that fit is close, the pixel is repainted as
k * GREY (so lines and shading survive). Markings, metal, glass, tyres etc. don't fit and are kept.

Panel lines are softened (the source's are near-black), and a faint low-frequency tonal variation
breaks up large panels. The paint mask is written next to the output (<out>_mask.png) so the
metal-roughness map can be given the paint's satin finish.

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

# Target paint (sRGB): the darker blue-grey of service Tejas (matched to air-to-air photographs).
GREY = np.array([156, 165, 171], dtype=np.float32) / 255.0
# How much of the source's shading (panel lines, rivets) is kept: 1 = all, 0 = flat paint.
LINE_KEEP = 0.55
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
    k = np.where(best_k < 1.0, 1.0 - (1.0 - best_k) * LINE_KEEP, best_k)
    # Faint weathering: smooth noise (+-4%) over a few hundred texels.
    rng = np.random.default_rng(7)
    lo = Image.fromarray((rng.random((max(8, h // 256), max(8, w // 256))) * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    mid = Image.fromarray((rng.random((max(8, h // 64), max(8, w // 64))) * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    var = 1.0 + 0.06 * (np.asarray(lo, np.float32) / 255.0 - 0.5) + 0.03 * (np.asarray(mid, np.float32) / 255.0 - 0.5)
    repainted = (k * var.reshape(-1))[:, None] * grey
    outp = wgt * repainted + (1.0 - wgt) * flat
    Image.fromarray((to_srgb(outp).reshape(h, w, 3) * 255.0 + 0.5).astype(np.uint8)).save(out)
    Image.fromarray((wgt.reshape(h, w) * 255.0 + 0.5).astype(np.uint8)).save(out.rsplit('.', 1)[0] + '_mask.png')
    print(f'repainted {float((wgt > 0.5).mean()) * 100:.1f}% of pixels -> {out}')


if __name__ == '__main__':
    main()
