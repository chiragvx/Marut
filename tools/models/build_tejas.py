"""
tools/models/build_tejas.py - builds public/models/tejas.glb from the Sketchfab source.

Source: "HAL Tejas" by dimal965, https://sketchfab.com/3d-models/hal-tejas-fd95c85e2452490cbe32f80175498441
(CC BY 4.0). Download its glTF zip into tools/models/source/tejas/ (git-ignored) and unzip it there.

Steps: repaint the base colour (repaint_tejas.py) at full size and resize the texture set to 2K,
then run Blender headless on blender_tejas.py (split, close canopy/airbrakes, hinges, export).
Usage: python -I tools/models/build_tejas.py [path to blender.exe]
"""
import os
import subprocess
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(HERE, 'source', 'tejas')
BUILD = os.path.join(SRC, 'build')
OUT = os.path.join(ROOT, 'public', 'models', 'tejas.glb')
BLENDER = sys.argv[1] if len(sys.argv) > 1 else r'C:\Program Files\Blender Foundation\Blender 4.5\blender.exe'
SIZE = 2048


def main() -> None:
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tex = os.path.join(SRC, 'textures')
    full = os.path.join(BUILD, 'baseColor_full.png')
    subprocess.run([sys.executable, '-I', os.path.join(HERE, 'repaint_tejas.py'), os.path.join(tex, 'HAL_Tejas_baseColor.png'), full], check=True)
    Image.open(full).resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(BUILD, 'baseColor.png'))
    for name in ('metallicRoughness', 'normal'):
        Image.open(os.path.join(tex, f'HAL_Tejas_{name}.png')).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(BUILD, f'{name}.png'))
    subprocess.run([BLENDER, '-b', '--factory-startup', '--python', os.path.join(HERE, 'blender_tejas.py'), '--',
                    os.path.join(SRC, 'scene.gltf'), BUILD.replace(os.sep, '/'), OUT], check=True)
    print(f'{OUT}: {os.path.getsize(OUT) / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
