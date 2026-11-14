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

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform, closest_point_on_tri

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

# Control surfaces. The source's tail is one piece (fin and tailplane in the body's meshes): cut the
# rudder (upper and lower) and the four elevators out of it along their hinge lines, each its own
# object carrying its hinge in its extras ('marut': group, hinge x0 y0 z0 x1 y1 z1 in glTF axes); the
# game turns each about its hinge (render/aircraftModels/c17Model.ts). Measured on the scaled model
# (Blender axes: nose +X, left +Y, up +Z):
# - fin: leading edge x = -16.23 - 0.907 (z - 8.82), trailing edge x = -19.40 - 0.902 (z - 8.80),
#   from its root fairing (z ~ 8.8) to the tailplane's (z ~ 14.5). Rudder: the aft 36% of the
#   chord, z 9.0 .. 14.4, split at 11.7 (the C-17's upper and lower rudders);
# - tailplane: leading edge (-17.8, |y| 0.5) .. (-23.94, 10.16), trailing edge ~ -25.6 .. -26.29,
#   mid-thickness z ~ 15.28. Elevators: aft ~30% of the chord, |y| 1.2 .. 9.95, split at 5.6 (two
#   per side).
FIN_LE = lambda z: -16.23 - 0.9073 * (z - 8.82)  # noqa: E731
FIN_TE = lambda z: -19.40 - 0.902 * (z - 8.80)  # noqa: E731
RUDDER_CHORD = 0.36
RUDDER_Z = (9.0, 11.7, 14.4)
ELEV_HINGE = ((-23.45, 1.2), (-25.55, 10.0))  # (x, |y|) at its inboard and outboard ends
ELEV_Z = 15.28
ELEV_Y = (1.2, 5.6, 9.95)


def rudder_x(z):
    return FIN_LE(z) + (1 - RUDDER_CHORD) * (FIN_TE(z) - FIN_LE(z))


def gltf_axes(v):
    return [round(v.x, 5), round(v.z, 5), round(-v.y, 5)]


def normals_snapshot(o):
    """The mesh's surface before a cut, world frame: its triangles (for the nearest-face lookup),
    their corners' positions and normals."""
    me = o.data
    M = o.matrix_world
    Mn = M.to_3x3().inverted().transposed()
    me.calc_loop_triangles()
    verts = [M @ v.co for v in me.vertices]
    cn = me.corner_normals
    tris = [(tuple(lt.vertices), tuple(lt.loops)) for lt in me.loop_triangles]
    normals = {li: (Mn @ cn[li].vector).normalized() for _, loops in tris for li in loops}
    return BVHTree.FromPolygons(verts, [t[0] for t in tris]), verts, tris, normals


def restore_normals(o, region, snap):
    """The cut faces' corners get their normals interpolated from the uncut surface they lie on (the
    cut itself interpolates the source's custom normals wrongly); every other corner keeps its own."""
    bvh, verts, tris, normals = snap
    me = o.data
    M = o.matrix_world
    Mt = M.to_3x3().transposed()
    Mn = M.to_3x3().inverted().transposed()
    keep = [Vector(n.vector) for n in me.corner_normals]
    touched = set()
    for p in me.polygons:
        c = M @ p.center
        if not region(c):
            continue
        pn = (Mn @ p.normal).normalized()
        touched.update(p.edge_keys)
        for li in p.loop_indices:
            v = M @ me.vertices[me.loops[li].vertex_index].co
            # A point just inside this face (from the corner towards the centre) finds the face it was cut from.
            # Thin skins put other faces within millimetres: of those, the one in this face's plane
            # (the face was cut from it), then the nearest.
            best = None
            score = -1e9
            q = v + (c - v) * 0.05
            for hit in bvh.find_nearest_range(v, 0.003):
                (ia, ib, ic), _ = tris[hit[2]]
                dq = (closest_point_on_tri(q, verts[ia], verts[ib], verts[ic]) - q).length
                sc_hit = abs(hit[1].dot(pn)) - 20.0 * hit[3] - 5.0 * dq
                if sc_hit <= score:
                    continue
                (ia, ib, ic), (la, lb, lc) = tris[hit[2]]
                w = barycentric_transform(v, verts[ia], verts[ib], verts[ic], Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)))
                w = Vector([max(0.0, x) for x in w])
                n = normals[la] * w[0] + normals[lb] * w[1] + normals[lc] * w[2]
                if n.length < 1e-6:
                    continue
                n.normalize()
                best = n
                score = sc_hit
            if best is not None:
                keep[li] = (Mt @ best).normalized()
    # Every restored corner its own normal (corners in a smooth fan would otherwise share one,
    # averaged): the restored faces' edges sharp; the rest of the mesh keeps the normals it had.
    sharp = me.attributes.get('sharp_edge') or me.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
    flags = [False] * len(me.edges)
    sharp.data.foreach_get('value', flags)
    key_to_edge = {e.key: e.index for e in me.edges}
    for ek in touched:
        flags[key_to_edge[ek]] = True
    sharp.data.foreach_set('value', flags)
    me.normals_split_custom_set(keep)

# Where the cuts can reach (pieces of cut faces can end up a little outside the cut's own region):
# the whole tail's faces are given their uncut normals back (an untouched face gets its own).
TAIL_BOX = lambda p: p.x < -15.0 and p.z > 8.0  # noqa: E731
SNAPSHOTS = {}
# Object name -> (the source surface's snapshot, the regions whose corners to restore).
RESTORE = {}


def cut_surface(name, group, a, b, plane_no, region, cuts, keep):
    """Bisects every mesh's faces in `region` (world point -> bool) along the hinge plane (through
    a-b, normal plane_no) and the `cuts` planes, then moves the faces aft of the hinge with keep(p)
    true into objects of their own, with the hinge as extras."""
    aft = plane_no if plane_no.dot(Vector((-1, 0, 0))) > 0 else -plane_no
    made = 0
    for o in [o for o in sc.objects if o.type == 'MESH' and 'marut' not in o]:
        M = o.matrix_world
        Minv = M.inverted()
        N3 = M.to_3x3().transposed()
        bm = bmesh.new()
        bm.from_mesh(o.data)
        snap = None
        inside = lambda: [f for f in bm.faces if region(M @ f.calc_center_median())]  # noqa: E731
        if not inside():
            bm.free()
            continue
        # The surface as the source has it (before any cut: later cuts would sample earlier ones' slivers).
        if o.name not in SNAPSHOTS:
            SNAPSHOTS[o.name] = normals_snapshot(o)
        snap = SNAPSHOTS[o.name]
        for co, no in [(a, aft)] + cuts:
            fs = inside()
            geom = list({e for f in fs for e in f.edges}) + list({v for f in fs for v in f.verts}) + fs
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=Minv @ co, plane_no=(N3 @ no).normalized())
        bm.faces.ensure_lookup_table()
        sel = {f.index for f in bm.faces if region(M @ f.calc_center_median()) and (M @ f.calc_center_median() - a).dot(aft) > 0
               and keep(M @ f.calc_center_median())}
        if not sel:
            bm.free()
            continue
        bm2 = bm.copy()
        bm2.faces.ensure_lookup_table()
        bmesh.ops.delete(bm2, geom=[f for f in bm2.faces if f.index not in sel], context='FACES')
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index in sel], context='FACES')
        # The cuts leave n-gons; the exporter's tangents need triangles or quads.
        for m in (bm, bm2):
            # (and slivers: zero-area faces hold no normal of their own)
            bmesh.ops.dissolve_degenerate(m, dist=1e-4, edges=m.edges[:])
            bmesh.ops.triangulate(m, faces=[f for f in m.faces if len(f.verts) > 4])
        me2 = o.data.copy()
        bm.to_mesh(o.data)
        bm2.to_mesh(me2)
        bm.free()
        bm2.free()
        piece = bpy.data.objects.new(f'{name}_{made}', me2)
        for col in o.users_collection:
            col.objects.link(piece)
        piece.parent = o.parent
        piece.matrix_parent_inverse = o.matrix_parent_inverse.copy()
        piece.matrix_basis = o.matrix_basis.copy()
        piece['marut'] = {'group': group, 'hinge': gltf_axes(a) + gltf_axes(b)}
        # Normals are put right once all the cuts are made (a later cut on the same mesh would undo them).
        RESTORE.setdefault(o.name, (snap, []))[1].append(TAIL_BOX)
        RESTORE.setdefault(piece.name, (snap, []))[1].append(lambda p: True)
        made += 1
    print('SURFACE', name, 'pieces', made, 'hinge', gltf_axes(a), gltf_axes(b))
    return made


bpy.context.view_layer.update()
z0, zm, z1 = RUDDER_Z
up = Vector((0, 0, 1))
fin_region = lambda p: p.x < -15.5 and abs(p.y) < 0.6 and 8.5 < p.z < 14.58  # noqa: E731
ra, rb = Vector((rudder_x(z0), 0, z0)), Vector((rudder_x(z1), 0, z1))
r_no = (rb - ra).cross(Vector((0, 1, 0))).normalized()
r_cuts = [(Vector((0, 0, z)), up) for z in RUDDER_Z]
cut_surface('rudderLower', 'rudder', ra, rb, r_no, fin_region, r_cuts, lambda p: z0 < p.z < zm)
cut_surface('rudderUpper', 'rudder', ra, rb, r_no, fin_region, r_cuts, lambda p: zm < p.z < z1)
for side, sgn in (('R', -1), ('L', 1)):
    (xa, ya), (xb, yb) = ELEV_HINGE
    ea, eb = Vector((xa, sgn * ya, ELEV_Z)), Vector((xb, sgn * yb, ELEV_Z))
    e_no = (eb - ea).cross(up).normalized()
    region = lambda p, s=sgn: p.x < -17 and 0.6 < s * p.y < 10.5 and 14.8 < p.z < 15.85  # noqa: E731
    e_cuts = [(Vector((0, sgn * y, 0)), Vector((0, 1, 0))) for y in ELEV_Y]
    y0, y1, y2 = ELEV_Y
    cut_surface('elevator' + side + 'In', 'elevator', ea, eb, e_no, region, e_cuts, lambda p, s=sgn: y0 < s * p.y < y1)
    cut_surface('elevator' + side + 'Out', 'elevator', ea, eb, e_no, region, e_cuts, lambda p, s=sgn: y1 < s * p.y < y2)
bpy.context.view_layer.update()
for oname, (snap, regions) in RESTORE.items():
    restore_normals(bpy.data.objects[oname], lambda p, rs=regions: any(r(p) for r in rs), snap)
meshes = [o for o in sc.objects if o.type == 'MESH']

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
