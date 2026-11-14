"""
tools/models/build_c17.py - builds public/models/c17.glb from the Sketchfab source.

Source: "c17 Globemaster with animation" by pilotcandle5470,
https://sketchfab.com/3d-models/c17-globemaster-with-animation-809e3e068f324db6b9cfe57611a69726 (CC BY 4.0).
Download its glTF zip into tools/models/source/c17/ (git-ignored) and unzip it there.

Steps:
1. One texture set for the whole aircraft (the game's aircraft shader samples one): every textured
   material's maps go into a tile of an atlas (base colour 4096, metal-roughness and normal 2048),
   the airframe's own map taking the top-left 3/4; the untextured materials become flat colour
   cells. Each tile is padded with a stretched copy of itself so mip levels do not bleed in the
   neighbours. The layout goes to Blender as JSON (ATLAS below; rects in base-colour pixels).
2. Blender headless on blender_c17.py: strip, thin, scale and turn the model, move each material's
   UVs into its tile, one material ('c17') plus the glass, keep the 10 s animation, export.
3. Hash the GLB for the cache-busting URL (src/render/aircraftModels/c17GlbVersion.ts).

Usage: python -I tools/models/build_c17.py [path to blender.exe] [source dir] [build dir]
"""
import hashlib
import json
import os
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BLENDER = sys.argv[1] if len(sys.argv) > 1 else r'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe'
SRC = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, 'source', 'c17')
BUILD = sys.argv[3] if len(sys.argv) > 3 else os.path.join(SRC, 'build')
OUT = os.path.join(ROOT, 'public', 'models', 'c17.glb')
VERSION_TS = os.path.join(ROOT, 'src', 'render', 'aircraftModels', 'c17GlbVersion.ts')

BASE = 4096
# Metal-roughness and normal atlases at this fraction of the base colour's size.
DETAIL_SCALE = 0.5
# Tiles: material -> (x, y, size) in base-colour pixels (y down, as the image).
T1, T5 = 1024, 512
ATLAS = {
    'airframemap': (0, 0, 3072),
    'landgear': (0, 3072, T1),
    'envelope': (1024, 3072, T1),
    'edge': (2048, 3072, T1),
    'engine': (3072, 3072, T1),
    'deviceroom': (3072, 0, T5),
    'material': (3584, 0, T5),
    'wall': (3072, 512, T5),
    'decoration': (3584, 512, T5),
    'chair': (3072, 1024, T5),
    'floorandwinbox': (3584, 1024, T5),
    'light': (3072, 1536, T5),
    'screen': (3584, 1536, T5),
    'connector2': (3072, 2048, T5),
}
# Untextured materials: flat cells (256 px) of the tile at (3584, 2048): base colour (linear), metal, rough.
FLAT_TILE = (3584, 2048)
FLAT = {
    'airframeblue': ((0.108521, 0.15332, 0.215576), 0.0, 0.5),
    'bump': ((0.8, 0.8, 0.8), 0.401408, 0.78169),
    'connect': ((0.265902, 0.285572, 0.2505), 0.316901, 0.795775),
    '.001': ((0.8, 0.8, 0.8), 0.739437, 0.5),
}
# Gutter round each tile (fraction of the tile): its UVs are inset by this much.
PAD = 0.012


def srgb(c: float) -> int:
    c = max(0.0, min(1.0, c))
    return round(255 * (12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055))


def tile_image(img: Image.Image, size: int) -> Image.Image:
    """The image at `size`, inset by the gutter over a stretched copy of itself (the bleed)."""
    out = img.resize((size, size), Image.LANCZOS)
    inner = max(1, round(size * (1 - 2 * PAD)))
    off = (size - inner) // 2
    out.paste(img.resize((inner, inner), Image.LANCZOS), (off, off))
    return out


def build_atlas(kind: str, scale: float, mode_default: tuple) -> Image.Image:
    size = round(BASE * scale)
    atlas = Image.new('RGB', (size, size), mode_default)
    tex = os.path.join(SRC, 'textures')
    for mat, (x, y, s) in ATLAS.items():
        img = Image.open(os.path.join(tex, f'{mat}_{kind}.png')).convert('RGB')
        atlas.paste(tile_image(img, round(s * scale)), (round(x * scale), round(y * scale)))
    cell = round(256 * scale)
    for k, (name, (col, metal, rough)) in enumerate(FLAT.items()):
        x = round(FLAT_TILE[0] * scale) + (k % 2) * cell
        y = round(FLAT_TILE[1] * scale) + (k // 2) * cell
        if kind == 'baseColor':
            c = tuple(srgb(v) for v in col)
        elif kind == 'metallicRoughness':
            c = (0, round(255 * rough), round(255 * metal))
        else:
            c = (128, 128, 255)
        atlas.paste(Image.new('RGB', (cell, cell), c), (x, y))
    return atlas


def main() -> None:
    os.makedirs(BUILD, exist_ok=True)
    build_atlas('baseColor', 1.0, (90, 104, 116)).save(os.path.join(BUILD, 'atlas_baseColor.png'))
    build_atlas('metallicRoughness', DETAIL_SCALE, (0, 128, 0)).save(os.path.join(BUILD, 'atlas_metallicRoughness.png'))
    build_atlas('normal', DETAIL_SCALE, (128, 128, 255)).save(os.path.join(BUILD, 'atlas_normal.png'))
    # UV rects (Blender's UV frame: v up from the image's bottom), inset by the gutter.
    rects = {}
    for mat, (x, y, s) in ATLAS.items():
        p = s * PAD
        rects[mat] = [(x + p) / BASE, 1 - (y + s - p) / BASE, (s - 2 * p) / BASE, (s - 2 * p) / BASE]
    for k, name in enumerate(FLAT):
        cx = FLAT_TILE[0] + (k % 2) * 256 + 128
        cy = FLAT_TILE[1] + (k // 2) * 256 + 128
        rects[name] = [cx / BASE, 1 - cy / BASE, 0, 0]
    rects['landgear.001'] = rects['landgear']
    layout = os.path.join(BUILD, 'atlas.json')
    with open(layout, 'w', encoding='utf-8') as f:
        json.dump({'rects': rects, 'dir': BUILD.replace(os.sep, '/')}, f)
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python', os.path.join(HERE, 'blender_c17.py'), '--',
                    os.path.join(SRC, 'scene.gltf'), OUT, layout], check=True)
    digest = hashlib.sha256(open(OUT, 'rb').read()).hexdigest()[:12]
    with open(VERSION_TS, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Generated by tools/models/build_c17.py: the content hash of public/models/c17.glb.\n')
        f.write(f"export const C17_GLB_HASH = '{digest}';\n")
    print(f'{OUT}: {os.path.getsize(OUT) / 1e6:.2f} MB, hash {digest}')


if __name__ == '__main__':
    main()
