"""
tools/models/blender_c17.py - Blender (headless) half of the C-17 model build (build_c17.py runs it).
Turns "c17 Globemaster with animation" by pilotcandle5470 (CC BY 4.0, Sketchfab 809e3e06) into a
game-weight GLB, keeping its animation:

- strips what is never seen from outside: the cargo bay's wiring looms and pipes, its seats, ladders
  and barricades, and the engines' compressors and turbines (hidden in the nacelles; the fans stay).
  The bay's walls and floor stay (the ramp opens), and the cockpit;
- thins the landing gear (DECIMATE_GEAR);
- scales it to the real airframe (the source is ~12% small: 46.5 m long against 53.04 m);
- turns it nose to Blender +X (glTF/three.js +X, as the Tejas model) with the static wheel bottoms
  at height 0 and the fuselage centred on x and y;
- keeps the source's one 10 s animation (its parts move in turn; see PART_WINDOWS in the extras);
  the game samples each part's tracks itself (render/aircraftModels/c17Model.ts);
- with an atlas layout (build_c17.py makes it): moves each material's UVs into its tile of one
  texture set and gives every surface but the glass one material, 'c17' (the game's aircraft shader
  samples a single set); exports tangents for the normal map.

Usage: blender -b --factory-startup --python blender_c17.py -- <scene.gltf> <out.glb> [atlas.json]
"""
import json
import math
import sys

import bpy
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = args[0], args[1]
ATLAS = args[2] if len(args) > 2 else None

REAL_LENGTH_M = 53.04
DECIMATE_GEAR = 0.45
# Materials only the cargo bay's clutter uses.
DROP_MATERIALS = {'wirewhite', 'wireblack', 'wireconnnect', 'pipe'}
# Object-name stems (the source's node names, numbered suffix removed) that are hidden or clutter
# ('chair' is the cargo bay's troop seats; the pilots' seats, 'driverseat', stay).
DROP_STEMS = ('compressor', 'turbine', 'ladder', 'barricade', 'chair', 'wire', 'pipe')
# The animation's timeline, s: which part moves when (for the game to sample each as its own driver).
PART_WINDOWS = {
    'spoilers': [0, 1], 'reversers': [0, 1], 'flaps': [1, 2], 'ailerons': [2, 3], 'slats': [3, 4],
    'tailDoorsRamp': [3, 6], 'crewDoors': [5, 10], 'gear': [6, 9], 'engineFans': [0, 9],
}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
sc = bpy.context.scene
sc.frame_set(1)


def stem(name):
    s = name.split('_')[0]
    return s.split('.')[0].rstrip('0123456789').lower()


def animated(o):
    while o:
        if o.animation_data and o.animation_data.action:
            return True
        o = o.parent
    return False


def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs if o.type == 'MESH')


meshes = [o for o in sc.objects if o.type == 'MESH']
before = tris(meshes)
drop = []
for o in meshes:
    mats = {m.name for m in o.data.materials if m}
    # The mesh node's parent carries the part's name (Object_N under "wire4_222" etc.).
    named = o.parent.name if o.parent else o.name
    st = stem(named)
    if mats and mats <= DROP_MATERIALS:
        drop.append(o)
    elif any(st.startswith(d) for d in DROP_STEMS):
        drop.append(o)
    elif mats == {'decoration'} and not animated(o):
        # Cargo-bay fittings (non-ASCII-named rails, ladders, barricades); the animated ones are door parts.
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        inside = all(abs(v.x) < 2.95 and 1.0 < v.z < 6.3 for v in bb)
        if inside:
            drop.append(o)
for o in drop:
    bpy.data.objects.remove(o, do_unlink=True)

# Thin the landing gear.
for o in [o for o in sc.objects if o.type == 'MESH']:
    if any(m and m.name == 'landgear' for m in o.data.materials) and len(o.data.polygons) > 60:
        mod = o.modifiers.new('thin', 'DECIMATE')
        mod.ratio = DECIMATE_GEAR

# Orientation, scale and datum on the top-level object (animation channels are in parent space,
# so they follow).
roots = [o for o in sc.objects if o.parent is None]
assert len(roots) == 1, [o.name for o in roots]
root = roots[0]
meshes = [o for o in sc.objects if o.type == 'MESH']


def bounds():
    bpy.context.view_layer.update()
    lo = Vector((1e9,) * 3)
    hi = -lo
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


lo, hi = bounds()
length = hi.y - lo.y
scale = REAL_LENGTH_M / length
# Nose (-Y) to +X, scaled.
root.matrix_world = Matrix.Rotation(math.radians(90), 4, 'Z') @ Matrix.Scale(scale, 4) @ root.matrix_world
lo, hi = bounds()
root.matrix_world = Matrix.Translation(Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))) @ root.matrix_world
lo, hi = bounds()

after = tris(meshes)
print(f'C17 tris {before} -> {after} (gear decimated at export), scale x{scale:.4f}, '
      f'size L {hi.x - lo.x:.2f} span {hi.y - lo.y:.2f} H {hi.z - lo.z:.2f} m')

root['c17'] = json.dumps({
    'source': 'c17 Globemaster with animation, pilotcandle5470, CC BY 4.0',
    'scale': round(scale, 5),
    'animationSec': 10,
    'partWindowsSec': PART_WINDOWS,
    'note': 'nose +X, up +Y (glTF), wheel bottoms at y 0 with the gear down (frame 0)',
})

if ATLAS:
    # One texture set: each material's UVs into its tile (flat-colour materials onto a cell's centre),
    # then one material for everything but the glass.
    with open(ATLAS, encoding='utf-8') as f:
        layout = json.load(f)
    rects = layout['rects']
    done = set()
    for o in [o for o in sc.objects if o.type == 'MESH']:
        me = o.data
        if me.name in done:
            continue
        done.add(me.name)
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        uv = me.uv_layers[0].data
        for p in me.polygons:
            m = me.materials[p.material_index] if me.materials else None
            r = rects.get(m.name) if m else None
            if r is None:
                if m and m.name != 'glass':
                    print('ATLAS: no tile for material', m.name, 'on', o.name)
                continue
            for li in p.loop_indices:
                u, v = uv[li].uv
                uv[li].uv = (r[0] + min(1, max(0, u)) * r[2], r[1] + min(1, max(0, v)) * r[3])
    mat = bpy.data.materials.new('c17')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')

    def tex(fn, non_color):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = bpy.data.images.load(layout['dir'] + '/' + fn)
        if non_color:
            n.image.colorspace_settings.name = 'Non-Color'
        return n

    nt.links.new(tex('atlas_baseColor.png', False).outputs['Color'], bsdf.inputs['Base Color'])
    mr = tex('atlas_metallicRoughness.png', True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(mr.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tex('atlas_normal.png', True).outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    mat.use_backface_culling = True
    for me in bpy.data.meshes:
        for i, m in enumerate(me.materials):
            if m is None or m.name != 'glass':
                me.materials[i] = mat
else:
    # Textures: the airframe's paint at 4K, its normal and metal-roughness at 2K, everything else at 1K
    # at most (only images the remaining materials use are exported).
    for img in bpy.data.images:
        w, h = img.size[:]
        if w == 0:
            continue
        cap = 4096 if img.name.startswith('airframemap_baseColor') else 2048 if img.name.startswith('airframemap') else 1024
        if w > cap:
            img.scale(cap, cap * h // w)

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_extras=True, export_yup=True, export_apply=True,
                          export_image_format='JPEG', export_jpeg_quality=85, export_animations=True, export_tangents=bool(ATLAS),
                          export_skins=False, export_morph=False, export_cameras=False, export_lights=False)
print('WROTE', OUT)
