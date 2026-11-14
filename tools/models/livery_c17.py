"""
tools/models/livery_c17.py - the Indian Air Force C-17 livery (No. 81 Sqn "Skylords"), painted into the
C-17's texture atlas. Research and sources: docs/spec/c17-iaf-livery.md.

Every marking is drawn procedurally (no photos): text with the system's fonts (Windows Nirmala UI for
the Devanagari, Bahnschrift for the Latin), the roundels and fin flash as shapes. Each is placed on the
model in metres (Blender axes of the built model: nose +X, left +Y, up +Z, wheels at z 0) and projected
onto the skin: every texel of the triangles under a marking gets its 3D point, and the marking's colour
there (supersampled), so curvature, UV rotation, scale and mirroring are all taken care of.

The source maps the left side onto the right side's texture (mirrored UVs): a symmetric marking (the
roundels, the fin flash, whose green leads on both sides) is painted once and shows on both. The titles
and serials are not symmetric, so build_c17 / blender_c17 cut each one's patch of skin out along its
box (UNIQUE below) and move that patch's UVs to space of its own in the atlas (at a higher texel
density); this script first copies the original texture there (base colour, metal-roughness, normal),
so the moved patch looks the same, then paints it.

Run by blender_c17.py (system Python, with numpy and Pillow):
    python -I livery_c17.py <livery.npz> <livery.json> <build dir>
It reads atlas_{baseColor,metallicRoughness,normal}.png from the build dir and writes *_iaf.png.
"""
import json
import math
import os
import sys

import numpy as np

FONTS = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
BASE = 4096
DETAIL_SCALE = 0.5

SERIAL = 'CB-8002'
# Indian national colours (flag code shades as commonly given: India saffron, India green).
SAFFRON = (255, 153, 51)
WHITE = (250, 250, 248)
GREEN = (19, 136, 8)
INK = (22, 22, 24)

# Fuselage-side marks: faces of that side (|y| < this) facing sideways.
FUSE_Y = 3.7
FIN_Y = 0.6

# Text marks that differ left and right: name, side (+1 left, -1 right), text, font (file, face index,
# variation), the ink box in metres (centre x, centre z, width, height) as seen from that side, and the
# cut margin round it (the patch moved to its own texture).
UNIQUE = [
    # Left forward fuselage, behind the flight deck windows: "Bharatiya Vayu Sena" (photos: starts
    # ~4.4 m behind the nose, about the windows' height, ~7.3 m long; 6.8 here, to clear this model's
    # wing-root fairing).
    dict(name='titleHi', side=1, text='भारतीय वायु सेना', font=('Nirmala.ttc', 1, None),
         box=(18.9, 6.55, 6.8, 0.84)),
    # Right forward fuselage: "INDIAN AIR FORCE" (ends ~4.6 m behind the nose, ~6.4 m long, 0.52 m caps).
    dict(name='titleEn', side=-1, text='INDIAN AIR FORCE', font=('bahnschrift.ttf', 0, b'SemiBold'),
         box=(18.6, 6.65, 6.4, 0.52)),
    # Serial, black, high on the fin forward of the rudder (both sides).
    dict(name='serialL', side=1, text=SERIAL, font=('bahnschrift.ttf', 0, b'SemiBold'),
         box=(-19.1, 14.08, 2.1, 0.45)),
    dict(name='serialR', side=-1, text=SERIAL, font=('bahnschrift.ttf', 0, b'SemiBold'),
         box=(-19.1, 14.08, 2.1, 0.45)),
]
CUT_MARGIN = 0.22

# Symmetric marks painted in place (both sides share the texture).
ROUNDEL_FUSE = dict(centre=(-10.9, 6.45), d=1.35)          # rear fuselage, both sides
ROUNDEL_WING = dict(centre=(1.4, 17.5), d=1.3)             # upper wing, both wings
FIN_FLASH = dict(centre=(-15.4, 10.66), w=1.2, h=0.8)      # green / white / saffron, green leading

# Markings of the source's generic (USAF-style) scheme to remove: dark marks inside these boxes are
# filled from the paint round them. (x0, x1, z0, z1) on the sides; the wing one is (x0, x1, y0, y1).
ERASE_SIDE = [
    (17.2, 21.3, 5.92, 6.8),   # "AIR FORCE" on the forward fuselage (read mirrored on the left)
    (-11.7, -10.1, 5.7, 7.2),   # the national-insignia ring on the rear fuselage
]
ERASE_WING = [(-2.3, 0.6, 21.6, 24.2)]  # the insignia ring near the left wing tip (both wings)
# The radome's dark blue becomes the airframe grey (IAF C-17 radomes are painted grey).
RADOME_X = 23.5
RADOME_SRC = (37, 55, 67)


def unique_cuts():
    """The patches cut out for the asymmetric marks (for blender_c17.py): slot k + 1 is UNIQUE[k]."""
    out = []
    for m in UNIQUE:
        cx, cz, w, h = m['box']
        out.append({'name': m['name'], 'side': m['side'], 'ymax': FIN_Y if cz > 9 else FUSE_Y,
                    'box': [cx - w / 2 - CUT_MARGIN, cx + w / 2 + CUT_MARGIN, cz - h / 2 - CUT_MARGIN, cz + h / 2 + CUT_MARGIN]})
    return out


# ---- marks as functions of plane coordinates (a, b) in metres -> RGBA (premultiplied-free, 0..1) ----

def text_mask(text, font):
    """The text's ink as a float mask (1 = ink), cropped to its ink box."""
    from PIL import Image, ImageDraw, ImageFont
    fname, index, variation = font
    ft = ImageFont.truetype(os.path.join(FONTS, fname), 360, index=index)
    if variation:
        ft.set_variation_by_name(variation)
    w = int(ft.getlength(text)) + 400
    im = Image.new('L', (w, 900), 0)
    ImageDraw.Draw(im).text((200, 200), text, font=ft, fill=255)
    box = im.getbbox()
    return np.asarray(im.crop(box)).astype(np.float32) / 255


def bilinear(img, x, y):
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = x - x0
    fy = y - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy)
            + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy)


def text_sampler(mark):
    mask = text_mask(mark['text'], mark['font'])
    _, _, w, h = mark['box']
    mh, mw = mask.shape
    ink = np.array(INK, np.float32) / 255

    def sample(a, b):
        inside = (np.abs(a) <= w / 2) & (np.abs(b) <= h / 2)
        al = bilinear(mask, (a / w + 0.5) * (mw - 1), (0.5 - b / h) * (mh - 1)) * inside
        return np.broadcast_to(ink, a.shape + (3,)), al
    return sample


def roundel_sampler(d):
    """IAF roundel: saffron ring, white ring, green centre, equal widths (diameters 1 : 2/3 : 1/3)."""
    cols = np.array([SAFFRON, WHITE, GREEN], np.float32) / 255

    def sample(a, b):
        r = np.hypot(a, b) / (d / 2)
        k = np.clip((r * 3).astype(int), 0, 2)
        k = 2 - k  # r < 1/3: green
        return cols[k], (r <= 1).astype(np.float32)
    return sample


def flash_sampler(w, h):
    """Fin flash: vertical green / white / saffron bands, green at the leading edge (a = x forward)."""
    cols = np.array([GREEN, WHITE, SAFFRON], np.float32) / 255

    def sample(a, b):
        k = np.clip(((w / 2 - a) / w * 3).astype(int), 0, 2)
        return cols[k], ((np.abs(a) <= w / 2) & (np.abs(b) <= h / 2)).astype(np.float32)
    return sample


# ---- rasterising triangles in texture space ----

SUB = 4  # supersamples per texel edge


def raster(P, UV, sel, plane, sample, written):
    """Samples `sample` (plane coords -> colour (n, 3) 0..1, alpha (n,)) over the texels of triangles
    `sel` (texture px, y down); plane(points (n, 3)) -> (a, b). Texels within a pixel of a triangle's
    edge count too (its plane extended), so seams get no grey cracks. A texel goes to the first
    triangle that reaches it (`written`, H x W, updated). Returns texel rows, columns, colour, alpha."""
    H, W = written.shape
    out = []
    offs = (np.arange(SUB) + 0.5) / SUB - 0.5
    for t in np.nonzero(sel)[0]:
        p = UV[t].astype(np.float64)
        x0, y0 = np.floor(p.min(0) - 1.5).astype(int)
        x1, y1 = np.ceil(p.max(0) + 1.5).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, W - 1), min(y1, H - 1)
        if x1 < x0 or y1 < y0:
            continue
        e1 = p[1] - p[0]
        e2 = p[2] - p[0]
        den = e1[0] * e2[1] - e1[1] * e2[0]
        if abs(den) < 1e-9:
            continue
        ys, xs = np.mgrid[y0:y1 + 1, x0:x1 + 1]
        cx = xs + 0.5
        cy = ys + 0.5

        def bary(x, y):
            dx = x - p[0][0]
            dy = y - p[0][1]
            l1 = (dx * e2[1] - dy * e2[0]) / den
            l2 = (e1[0] * dy - e1[1] * dx) / den
            return 1 - l1 - l2, l1, l2
        l0, l1, l2 = bary(cx, cy)
        # Distance (px) of the texel centre inside each edge: lambda_i * height_i.
        hgt = [abs(den) / np.linalg.norm(p[(i + 2) % 3] - p[(i + 1) % 3]) for i in range(3)]
        inside = (l0 * hgt[0] > -1.0) & (l1 * hgt[1] > -1.0) & (l2 * hgt[2] > -1.0)
        inside &= ~written[y0:y1 + 1, x0:x1 + 1]
        if not inside.any():
            continue
        iy, ix = np.nonzero(inside)
        acc_c = np.zeros((len(ix), 3), np.float32)
        acc_a = np.zeros(len(ix), np.float32)
        for oy in offs:
            for ox in offs:
                b0, b1, b2 = bary(cx[iy, ix] + ox, cy[iy, ix] + oy)
                X = b0[:, None] * P[t, 0] + b1[:, None] * P[t, 1] + b2[:, None] * P[t, 2]
                a, b = plane(X)
                c, al = sample(a, b)
                acc_c += c * al[:, None]
                acc_a += al
        n = SUB * SUB
        gy, gx = iy + y0, ix + x0
        alpha = acc_a / n
        colour = np.where(acc_a[:, None] > 0, acc_c / np.maximum(acc_a, 1e-6)[:, None], 0)
        written[gy, gx] = True
        out.append((gy, gx, colour, alpha))
    if not out:
        return np.zeros(0, int), np.zeros(0, int), np.zeros((0, 3), np.float32), np.zeros(0, np.float32)
    return tuple(np.concatenate(v) for v in zip(*out))


def composite(base, texels):
    gy, gx, colour, alpha = texels
    a = alpha[:, None]
    base[gy, gx] = base[gy, gx] * (1 - a) + colour * 255 * a
    return int((alpha > 0.5).sum())


def area(P, UV, sel, plane, box, shape):
    """Mask of the texels of triangles `sel` whose plane coordinates fall in box (a0, a1, b0, b1)."""
    a0, a1, b0, b1 = box
    gy, gx, _, al = raster(P, UV, sel, plane, lambda a, b: (
        np.zeros(a.shape + (3,), np.float32), ((a > a0) & (a < a1) & (b > b0) & (b < b1)).astype(np.float32)),
        np.zeros(shape, bool))
    m = np.zeros(shape, bool)
    m[gy[al > 0.5], gx[al > 0.5]] = True
    return m


# ---- the steps ----

def copy_islands(images, islands):
    """Copies each moved patch's source rect R to its own rect S (scaled k) in every map."""
    from PIL import Image
    out = []
    for img, s in images:
        img = img.copy()
        for isl in islands:
            rx, ry, rw, rh = (v * s for v in isl['R'])
            sx, sy = (round(v * s) for v in isl['S'])
            k = isl['k']
            w, h = math.ceil(rw * k), math.ceil(rh * k)
            patch = img.transform((w, h), Image.AFFINE, (1 / k, 0, rx, 0, 1 / k, ry), resample=Image.BILINEAR)
            img.paste(patch, (sx, sy))
        out.append(img)
    return out


def recolour_radome(base, P, UV, sel, dst):
    written = area(P, UV, sel, lambda X: (X[:, 0], X[:, 2]), (-1e9, 1e9, -1e9, 1e9), base.shape[:2])
    t = base[written]
    src = np.array(RADOME_SRC, np.float32)
    lum_w = np.array([0.2126, 0.7152, 0.0722], np.float32)
    n = np.linalg.norm(t, axis=1, keepdims=True) + 1e-6
    ang = np.arccos(np.clip((t / n) @ (src / np.linalg.norm(src)), -1, 1))
    rel = (t @ lum_w) / float(src @ lum_w)
    w = np.clip((0.12 - ang) / 0.05, 0, 1) * np.clip((2.0 - rel) / 0.4, 0, 1)
    new = np.array(dst, np.float32)[None] * np.clip(rel, 0, 1.6)[:, None]
    base[written] = t + (new - t) * w[:, None]
    return int((w > 0.5).sum())


def main():
    from PIL import Image
    npz, layout_json, build = sys.argv[1], sys.argv[2], sys.argv[3]
    d = np.load(npz)
    P, UV, N, slot = d['P'].astype(np.float64), d['UV'].astype(np.float64), d['N'], d['slot']
    with open(layout_json, encoding='utf-8') as f:
        layout = json.load(f)
    islands = layout['islands']
    paint = tuple(layout['paint'])

    names = ('baseColor', 'metallicRoughness', 'normal')
    imgs = [Image.open(os.path.join(build, f'atlas_{n}.png')).convert('RGB') for n in names]
    imgs = copy_islands(list(zip(imgs, (1.0, DETAIL_SCALE, DETAIL_SCALE))), islands)
    base = np.asarray(imgs[0]).astype(np.float32)

    C = P.mean(1)
    side_faces = lambda s, ymax: (s * C[:, 1] > 0) & (np.abs(C[:, 1]) < ymax) & (np.abs(N[:, 1]) > 0.25)  # noqa: E731
    up_faces = (N[:, 2] > 0.5) & (C[:, 2] < 9)

    # 1. Remove the generic scheme's marks.
    for x0, x1, z0, z1 in ERASE_SIDE:
        for s in (1, -1):
            sel = side_faces(s, FUSE_Y) & (C[:, 0] > x0 - 1.5) & (C[:, 0] < x1 + 1.5) & (C[:, 2] > z0 - 1.5) & (C[:, 2] < z1 + 1.5)
            # Only the texels whose 3D point is inside the box.
            sel_box = (x0, x1, z0, z1)
            n = erase_box(base, P, UV, sel, lambda X: (X[:, 0], X[:, 2]), sel_box)
            print(f'livery: erased {n} texels of marks in x {x0}..{x1} z {z0}..{z1} side {s}')
    for x0, x1, y0, y1 in ERASE_WING:
        for s in (1, -1):
            sel = up_faces & (C[:, 0] > x0 - 1.5) & (C[:, 0] < x1 + 1.5) & (s * C[:, 1] > y0 - 1.5) & (s * C[:, 1] < y1 + 1.5)
            n = erase_box(base, P, UV, sel, lambda X, s=s: (X[:, 0], s * X[:, 1]), (x0, x1, y0, y1))
            print(f'livery: erased {n} texels of marks on the wing, side {s}')
    sel = C[:, 0] > RADOME_X
    print('livery: radome texels repainted', recolour_radome(base, P, UV, sel, paint))

    H, W = base.shape[:2]

    def paint_mark(sel, plane, sample):
        return composite(base, raster(P, UV, sel, plane, sample, np.zeros((H, W), bool)))

    # 2. Symmetric marks, in the shared texture (painted from both sides; the same texels agree).
    cx, cz = ROUNDEL_FUSE['centre']
    r = ROUNDEL_FUSE['d'] / 2 + 0.3
    for s in (1, -1):
        sel = side_faces(s, FUSE_Y) & (np.abs(C[:, 0] - cx) < r + 1.5) & (np.abs(C[:, 2] - cz) < r + 1.5)
        n = paint_mark(sel, lambda X: (X[:, 0] - cx, X[:, 2] - cz), roundel_sampler(ROUNDEL_FUSE['d']))
        print(f'livery: fuselage roundel side {s}: {n} texels')
    fx, fz = FIN_FLASH['centre']
    for s in (1, -1):
        sel = side_faces(s, FIN_Y) & (C[:, 2] > 8.6) & (np.abs(C[:, 0] - fx) < 5) & (np.abs(C[:, 2] - fz) < 4)
        n = paint_mark(sel, lambda X: (X[:, 0] - fx, X[:, 2] - fz), flash_sampler(FIN_FLASH['w'], FIN_FLASH['h']))
        print(f'livery: fin flash side {s}: {n} texels')
    wx, wy = ROUNDEL_WING['centre']
    for s in (1, -1):
        sel = up_faces & (np.abs(C[:, 0] - wx) < 3) & (np.abs(s * C[:, 1] - wy) < 3)
        n = paint_mark(sel, lambda X, s=s: (X[:, 0] - wx, s * X[:, 1] - wy), roundel_sampler(ROUNDEL_WING['d']))
        print(f'livery: wing roundel side {s}: {n} texels')

    # 3. The asymmetric marks, each on its own patch (slot k + 1). Seen from its side, text reads
    #    nose-to-tail on the left (a = -x) and tail-to-nose on the right (a = +x); up is +z.
    for k, m in enumerate(UNIQUE):
        mx, mz, _, _ = m['box']
        s = m['side']
        sel = slot == k + 1
        n = paint_mark(sel, lambda X, s=s, mx=mx, mz=mz: (-s * (X[:, 0] - mx), X[:, 2] - mz), text_sampler(m))
        print(f"livery: {m['name']} on {int(sel.sum())} triangles: {n} texels")

    Image.fromarray(np.clip(base + 0.5, 0, 255).astype(np.uint8)).save(os.path.join(build, 'atlas_baseColor_iaf.png'))
    imgs[1].save(os.path.join(build, 'atlas_metallicRoughness_iaf.png'))
    imgs[2].save(os.path.join(build, 'atlas_normal_iaf.png'))


def _near(mask):
    g = mask.copy()
    g[1:] |= mask[:-1]
    g[:-1] |= mask[1:]
    g[:, 1:] |= mask[:, :-1]
    g[:, :-1] |= mask[:, 1:]
    return g


def erase_box(base, P, UV, sel, plane, box):
    """Removes the dark marks (text, rings) on the texels of triangles `sel` whose plane coordinates
    fall in `box` (a0, a1, b0, b1): they and a margin (their anti-aliasing, and the light halo a
    bicubic copy leaves) are filled from the paint round them by repeated neighbour averaging.
    Coloured marks (the yellow formation lights) are left alone. Returns the dark texels found."""
    inbox = area(P, UV, sel, plane, box, base.shape[:2])
    ys, xs = np.nonzero(inbox)
    if not len(ys):
        return 0
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    crop = base[y0:y1, x0:x1]
    m = inbox[y0:y1, x0:x1]
    lum = crop @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    grey = (crop.max(2) - crop.min(2)) < 40
    ref = np.median(lum[m])
    dark = m & grey & (lum < 0.72 * ref)
    odd = m & grey & (np.abs(lum / ref - 1) > 0.07)
    grown = dark.copy()
    for _ in range(3):
        grown = grown | (_near(grown) & odd)
    for _ in range(2):
        grown = _near(grown) & m
    known = m & ~grown & ~odd
    val = np.where(known[..., None], crop, 0).astype(np.float32)
    wgt = known.astype(np.float32)
    todo = grown.copy()
    for _ in range(400):
        if not todo.any():
            break
        pv = np.pad(val * wgt[..., None], ((1, 1), (1, 1), (0, 0)))
        pw = np.pad(wgt, 1)
        hh, ww = wgt.shape
        sv = sum(pv[1 + dy:1 + dy + hh, 1 + dx:1 + dx + ww] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        sw = sum(pw[1 + dy:1 + dy + hh, 1 + dx:1 + dx + ww] for dy in (-1, 0, 1) for dx in (-1, 0, 1))
        new = todo & (sw > 0)
        val[new] = sv[new] / sw[new][:, None]
        wgt[new] = 1
        todo &= ~new
    if todo.any():  # walled in by other odd texels: the paint's median
        val[todo] = np.median(crop[known], axis=0)
    crop[grown] = val[grown]
    base[y0:y1, x0:x1] = crop
    return int(dark.sum())


if __name__ == '__main__':
    main()
