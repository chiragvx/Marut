"""
tools/models/blender_jf17.py - Blender (headless) half of the JF-17 model build (build_jf17.py runs
it). Turns the Sketchfab "JF-17" by dimal965 (CC BY 4.0) into the GLB the renderer loads
(render/aircraftModels/gltfModel.ts; same conventions as blender_tejas.py):

- moves it into the sim's body frame (x forward, y up, z right; Blender X/Y/Z = body x/-z/y): the
  main wheels' contact under the physics' main gear (the JF-17 shares the Tejas's gear legs,
  aircraft/aggressors.ts), their bottoms at body y -1.62 as the Tejas's;
- the source is already in pieces (one object per moving part); splits the main gear object into
  left and right legs and wheels, and the nose gear into leg and wheel;
- closes the canopy (the source is posed parked, canopy up);
- finds each moving part's hinge (pivot + unit axis, body frame, signs as the procedural Tejas's):
  all-moving tailplanes (elevon drivers), flaperons (aileron drivers), leading-edge flaps (slat),
  rudder, gear legs, wheels and doors;
- cuts the source's nozzle out for the renderer's own, and writes the pylons (measured off the
  model: wingtip rails, two underwing pylons a side, the centreline), lights, nozzle and canopy box
  into glTF extras.

Usage: blender -b --factory-startup --python blender_jf17.py -- <scene.gltf> <textures dir> <out.glb>
"""
import math
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.interpolate import poly_3d_calc
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index('--') + 1:]
SRC, TEX_DIR, OUT = args[0], args[1], args[2]

# The physics' main gear (aircraft/tejasGeometry.ts gear mainLeft/mainRight x) and the Tejas GLB's
# static wheel bottom (blender_tejas.py WHEEL_BOTTOM_Y).
MAIN_GEAR_X = -0.75
WHEEL_BOTTOM_Y = -1.62

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)


def body(v):
    """Blender coords -> body frame (x, y, z)."""
    return Vector((v.x, v.z, -v.y))


def blend(p):
    """Body frame -> Blender coords."""
    return Vector((p[0], -p[2], p[1]))


# --- 1. Bake every object's transform (the source's nose is already +X, up +Z). ---
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
for o in meshes:
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = Matrix.Identity(4)
    o.data.transform(mw)
for o in [o for o in bpy.data.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)


SOURCE = {o.name.split('_')[0]: o for o in meshes}


def src(prefix):
    return SOURCE[prefix]


def verts(o):
    return [body(v.co) for v in o.data.vertices]


def centre(o):
    vs = verts(o)
    return sum(vs, Vector()) / len(vs)


# --- 2. Pieces. ---
def components(o):
    """Face sets connected through shared vertex positions (UV seams split the vertices)."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    key = {}
    rep = [key.setdefault(tuple(round(c, 4) for c in v.co), len(key)) for v in bm.verts]
    par = list(range(len(key)))

    def f(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for face in bm.faces:
        ids = [rep[v.index] for v in face.verts]
        for a in ids[1:]:
            ra, rb = f(ids[0]), f(a)
            if ra != rb:
                par[ra] = rb
    comps = {}
    for face in bm.faces:
        comps.setdefault(f(rep[face.verts[0].index]), []).append(face.index)
    bm.faces.ensure_lookup_table()
    out = []
    for faces in comps.values():
        vs = [body(v.co) for fi in faces for v in bm.faces[fi].verts]
        mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
        mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
        out.append(dict(faces=set(faces), mn=mn, mx=mx, n=len(faces)))
    bm.free()
    return out


def split(o, sets):
    """New objects, one per {name: face index set} of `o`."""
    out = {}
    for name, faces in sets.items():
        if not faces:
            continue
        c = o.copy()
        c.data = o.data.copy()
        bpy.context.scene.collection.objects.link(c)
        bm = bmesh.new()
        bm.from_mesh(c.data)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in faces], context='FACES')
        bm.to_mesh(c.data)
        bm.free()
        c.name = name
        out[name] = c
    bpy.data.objects.remove(o)
    return out


def inside(c, box, tol=0.01):
    mn, mx = box
    return all(c['mn'][i] >= mn[i] - tol and c['mx'][i] <= mx[i] + tol for i in range(3))


groups = {}


def add(name, o):
    groups.setdefault(name, []).append(o)


def side_of(o):
    return 'R' if centre(o).z > 0 else 'L'


main = src('body')
add('body', main)
add('windscreen', src('glass'))
add('canopyFrame', src('Object026'))
add('canopyGlass', src('Object033'))
for p in ('Object034', 'Object035'):
    o = src(p)
    add('tailplane' + side_of(o), o)
add('rudder', src('Object036'))
for p in ('Object037', 'Object038', 'Object039', 'Object040'):
    o = src(p)
    add('flaperon%s%d' % (side_of(o), 1 if abs(centre(o).z) > 2.86 else 0), o)
for p in ('Object041', 'Object042', 'Object043', 'Object044'):
    o = src(p)
    add('slat%s%d' % (side_of(o), 1 if abs(centre(o).z) > 2.86 else 0), o)
for p in ('Object027', 'Object028'):
    o = src(p)
    add('noseDoor' + side_of(o), o)
for p in ('Object029', 'Object031'):
    o = src(p)
    add('mainBayDoor' + side_of(o), o)
for p in ('Object030', 'Object032'):
    o = src(p)
    add('mainAftDoor' + side_of(o), o)

# Main gear: one object for both legs. Per side, the wheel is the tyre (the largest piece) and
# everything inside its box (hub, brake); the rest is the leg.
mg = src('Object023')
cs = components(mg)
sets = {}
for side, sgn in (('R', 1), ('L', -1)):
    mine = [c for c in cs if (c['mn'].z + c['mx'].z) / 2 * sgn > 0]
    tyre = max(mine, key=lambda c: c['n'])
    box = (tyre['mn'], tyre['mx'])
    wheel = [c for c in mine if inside(c, box)]
    sets['mainWheel' + side] = set().union(*[c['faces'] for c in wheel])
    sets['mainGear' + side] = set().union(*[c['faces'] for c in mine if c not in wheel])
for name, o in split(mg, sets).items():
    add(name, o)
ng = src('Object024')
cs = components(ng)
tyre = max(cs, key=lambda c: c['n'])
wheel = [c for c in cs if inside(c, (tyre['mn'], tyre['mx']))]
for name, o in split(ng, {'noseWheels': set().union(*[c['faces'] for c in wheel]),
                          'noseGear': set().union(*[c['faces'] for c in cs if c not in wheel])}).items():
    add(name, o)


def all_verts(names):
    return [v for name in names for o in groups.get(name, []) for v in verts(o)]


def transform_group(names, m):
    for name in names:
        for o in groups.get(name, []):
            o.data.transform(m)


# --- 3. Datum: the main wheels' contact at the physics' main gear x, their bottoms at WHEEL_BOTTOM_Y. ---
mw = all_verts(['mainWheelR', 'mainWheelL'])
wheel_x = (min(v.x for v in mw) + max(v.x for v in mw)) / 2
d_body = Vector((MAIN_GEAR_X - wheel_x, WHEEL_BOTTOM_Y - min(v.y for v in mw), 0))
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.data.transform(Matrix.Translation(blend(d_body)))
print('DATUM shift', tuple(round(c, 3) for c in d_body))

for k in sorted(groups):
    print('GROUP', k, len(groups[k]), sum(len(o.data.polygons) for o in groups[k]))

bm = bmesh.new()
bm.from_mesh(main.data)
fuselage = BVHTree.FromBMesh(bm)
bm.free()


def fit_angle(names, pivot_b, axis_b, probe, lo, hi, inside_tol=0.01):
    """Angle (deg) about the hinge that brings the `probe` vertices of `names` closest to the airframe."""
    pv = blend(pivot_b)
    ax = blend(axis_b).normalized()
    pts = [blend(v) for v in probe]
    best = (1e9, 0.0)
    a = lo
    while a <= hi:
        m = Matrix.Translation(pv) @ Matrix.Rotation(math.radians(a), 4, ax) @ Matrix.Translation(-pv)
        d = 0.0
        for p in pts:
            q = m @ p
            hit = fuselage.find_nearest(q)
            if hit[0] is None:
                d += 1.0
                continue
            d += hit[3] if (q - hit[0]).dot(hit[1]) >= -inside_tol else 1.0 + hit[3]
        best = min(best, (d / len(pts), a))
        a += 0.5
    return best[1], best[0]


def hinge_rotation(pivot_b, axis_b, deg):
    pv = blend(pivot_b)
    return Matrix.Translation(pv) @ Matrix.Rotation(math.radians(deg), 4, blend(axis_b).normalized()) @ Matrix.Translation(-pv)


# --- 4. Close the canopy: it hinges at its rear, about the lateral axis. ---
frame_v = all_verts(['canopyFrame'])
zmax = max(abs(v.z) for v in frame_v)
rear = min(frame_v, key=lambda v: v.x + 0.5 * v.y)
canopy_pivot = (rear.x, rear.y, 0.0)
sill = [v for v in frame_v if abs(v.z) > 0.85 * zmax]
canopy_deg, canopy_err = fit_angle(['canopyFrame'], canopy_pivot, (0, 0, 1), sill, -100, 100, inside_tol=0.06)
print('CANOPY pivot', tuple(round(c, 3) for c in canopy_pivot), 'close', canopy_deg, 'deg, sill error', round(canopy_err, 3))
transform_group(['canopyFrame', 'canopyGlass'], hinge_rotation(canopy_pivot, (0, 0, 1), canopy_deg))

# --- 5. Hinges. ---
deg = math.pi / 180
parts = {}


def edge_line(vs, span, chord, front, mid=False):
    """Hinge line along one edge (see blender_tejas.py): returns (point at the inner end, unit dir)."""
    lo = min(span(v) for v in vs)
    hi = max(span(v) for v in vs)
    pts = []
    for i in range(8):
        a = lo + (hi - lo) * i / 8
        b = lo + (hi - lo) * (i + 1) / 8
        bin_v = [v for v in vs if a <= span(v) <= b]
        if bin_v:
            ext = max(bin_v, key=chord) if front else min(bin_v, key=chord)
            if mid:
                near = [v for v in bin_v if abs(chord(v) - chord(ext)) < 0.015]
                ext = sum(near, Vector()) / len(near)
            pts.append(ext)
    n = len(pts)
    c = sum(pts, Vector()) / n
    ts = [span(p) - span(c) for p in pts]
    tt = sum(t * t for t in ts) or 1.0
    d = sum(((p - c) * t for p, t in zip(pts, ts)), Vector()) / tt
    inner = c + d * (lo - span(c))
    return inner, d.normalized()


def unit_pos_z(v):
    v = v.normalized()
    return -v if v.z < 0 else v


def mid_y(vs):
    return (min(v.y for v in vs) + max(v.y for v in vs)) / 2


for side, sgn in (('R', 1), ('L', -1)):
    # All-moving tailplane: turns on its spigot, at ~35% of the root chord, about the lateral axis
    # tilted with the tailplane's anhedral. Elevon sign: + = trailing edge down.
    vs = all_verts(['tailplane' + side])
    zr = min(abs(v.z) for v in vs)
    zt = max(abs(v.z) for v in vs)
    root = [v for v in vs if abs(v.z) < zr + 0.08]
    tip = [v for v in vs if abs(v.z) > zt - 0.08]
    xr0, xr1 = min(v.x for v in root), max(v.x for v in root)
    pivot = Vector((xr1 - 0.35 * (xr1 - xr0), mid_y(root), zr * sgn))
    axis = unit_pos_z(Vector((0, mid_y(tip) - mid_y(root), (zt - zr) * sgn)))
    parts['tailplane' + side] = dict(driver='elevon' + side, pivot=pivot, axis=axis, travelRad=0)
    # Flaperons: hinge along the leading edge; roll only (aileron drivers).
    for k in (0, 1):
        name = 'flaperon%s%d' % (side, k)
        inner, d = edge_line(all_verts([name]), lambda v: abs(v.z), lambda v: v.x, True, mid=True)
        parts[name] = dict(driver='aileron' + side, pivot=inner, axis=unit_pos_z(d), travelRad=0)
    # Leading-edge flaps: hinge along the trailing edge; droop = negative about +z.
    for k in (0, 1):
        name = 'slat%s%d' % (side, k)
        inner, d = edge_line(all_verts([name]), lambda v: abs(v.z), lambda v: v.x, False, mid=True)
        parts[name] = dict(driver='slat', pivot=inner, axis=unit_pos_z(d), travelRad=-20 * deg)

    # Main gear: swings forward and in, along the well's arm, the wheel ending upright in the well's
    # forward pocket (under the forward bay door). The pocket: where the belly seen from below is
    # recessed to the well floor ahead of the leg.
    wv = all_verts(['mainWheel' + side])
    wc = Vector(((min(v.x for v in wv) + max(v.x for v in wv)) / 2, (min(v.y for v in wv) + max(v.y for v in wv)) / 2,
                 (min(v.z for v in wv) + max(v.z for v in wv)) / 2))
    # The top of the oleo, over the wheel (not the retraction strut reaching forward from it).
    vs = [v for v in all_verts(['mainGear' + side]) if abs(v.x - wc.x) < 0.25]
    top = max(vs, key=lambda v: v.y)
    leg = wc - top
    floor = []
    for i in range(28):
        x = -0.1 + i * 0.04
        for k in range(16):
            z = sgn * (0.2 + k * 0.04)
            h = fuselage.ray_cast(blend((x, -4.0, z)), blend((0, 1, 0)))
            if h[0] is not None and body(h[0]).y > -0.12:
                floor.append(Vector((x, body(h[0]).y, z)))
    pocket = sum(floor, Vector()) / len(floor)
    wheel_r = (max(v.y for v in wv) - min(v.y for v in wv)) / 2
    aim = Vector((pocket.x, pocket.y - wheel_r - 0.02, pocket.z))
    stow = (aim - top).normalized()
    g_axis = leg.cross(stow).normalized()
    g_ang = leg.angle(stow)
    print('MAIN WELL', side, 'pocket', tuple(round(c, 3) for c in pocket), len(floor), 'cells; wheel aimed at', tuple(round(c, 3) for c in aim))
    print('MAIN GEAR', side, 'top', tuple(round(c, 3) for c in top), 'wheel', tuple(round(c, 3) for c in wc), 'stowed at',
          tuple(round(c, 3) for c in top + stow * leg.length), 'angle', round(math.degrees(g_ang), 1))
    parts['mainGear' + side] = dict(driver='gear', pivot=Vector((top.x, top.y, top.z)), axis=g_axis, travelRad=g_ang)

    # Nose doors: hinged along their top edge (axis along x); they swing inwards to horizontal.
    vs = all_verts(['noseDoor' + side])
    ymax = max(v.y for v in vs)
    topv = [v for v in vs if v.y > ymax - 0.03]
    hz = sum(v.z for v in topv) / len(topv)
    pivot = Vector(((min(v.x for v in vs) + max(v.x for v in vs)) / 2, ymax, hz))
    bot = min(vs, key=lambda v: v.y)
    dd = Vector((0, bot.y - pivot.y, bot.z - pivot.z)).normalized()
    cur = math.atan2(dd.z * sgn, -dd.y)  # 0 = straight down, + = outboard
    parts['noseDoor' + side] = dict(driver='gear', pivot=pivot, axis=Vector((sgn, 0, 0)), travelRad=math.pi / 2 + cur, keepVisible=True)
    # The aft door is mounted on the leg: it moves with it (and folds away with it).
    parts['mainAftDoor' + side] = dict(parts['mainGear' + side])
    # The forward bay door: hinged along its top edge, swinging in and up to close the pocket.
    for name in ('mainBayDoor' + side,):
        vs = all_verts([name])
        ymax = max(v.y for v in vs)
        topv = [v for v in vs if v.y > ymax - 0.04]
        a0 = min(topv, key=lambda v: v.x)
        a1 = max(topv, key=lambda v: v.x)
        pivot = (a0 + a1) / 2
        axis = (a1 - a0).normalized() * sgn  # ~ +x (R) / -x (L): + = swing inwards
        ymin = min(v.y for v in vs)
        far = [v for v in vs if v.y < ymin + 0.08]
        close_deg, err = fit_angle([name], pivot, axis, far, 0, 150, inside_tol=0.03)
        print('DOOR', name, 'close', close_deg, 'err', round(err, 3))
        parts[name] = dict(driver='gear', pivot=pivot, axis=axis, travelRad=close_deg * deg, keepVisible=True)

# Nose gear: folds aft about +z from the top of the leg into the bay behind it (between the doors).
vs = all_verts(['noseGear'])
oleo = [v for v in vs if abs(v.z) < 0.08]
top = max(oleo, key=lambda v: v.y)
parts['noseGear'] = dict(driver='gear', pivot=Vector((top.x, top.y, 0)), axis=Vector((0, 0, 1)), travelRad=-88 * deg)

# Rudder: hinge down the leading edge (top -> bottom); + = trailing edge left.
vs = all_verts(['rudder'])
botv, d = edge_line(vs, lambda v: v.y, lambda v: v.x, True)
parts['rudder'] = dict(driver='rudder', pivot=botv, axis=-d if d.y > 0 else d, travelRad=0)

# Wheels: axle through the tyre's centre along the principal direction nearest the lateral axis.
for wl, gl in (('noseWheels', 'noseGear'), ('mainWheelR', 'mainGearR'), ('mainWheelL', 'mainGearL')):
    vs = all_verts([wl])
    pts = np.array([tuple(v) for v in vs])
    c = (pts.min(0) + pts.max(0)) / 2
    w, ev = np.linalg.eigh(np.cov((pts - c).T))
    ax = ev[:, int(np.argmax(np.abs(ev[2, :])))]
    ax = ax if ax[2] >= 0 else -ax
    rad = float(np.max(np.linalg.norm(np.cross(pts - c, ax), axis=1)))
    parts[wl] = dict(driver='wheel', pivot=Vector(tuple(c)), axis=Vector(tuple(ax)), travelRad=0, parent=gl, radius=rad)
    print('WHEEL', wl, 'centre', tuple(round(float(x), 3) for x in c), 'axis', tuple(round(float(x), 3) for x in ax), 'r', round(rad, 3))
# Where the physics should put the nose leg: under the nose wheel (the main legs are the physics' own).
nw = parts['noseWheels']
print('NOSE CONTACT x', round(nw['pivot'].x, 3), 'y', round(nw['pivot'].y - nw['radius'], 3))

# --- 5b. Skin sampling, bay lids, speed brakes. ---
def skin_hit(x, z):
    """(body point, polygon index) of the first airframe surface seen from below at (x, z), or None."""
    h = fuselage.ray_cast(blend((x, -4.0, z)), blend((0, 1, 0)))
    return None if h[0] is None else (body(h[0]), h[2])


uv_layer = main.data.uv_layers.active.data


def skin_uv(x, z):
    """The skin's texture coordinate under (x, z) (barycentric over the hit polygon)."""
    h = fuselage.ray_cast(blend((x, -4.0, z)), blend((0, 1, 0)))
    if h[0] is None:
        return None
    poly = main.data.polygons[h[2]]
    cos = [main.data.vertices[i].co for i in poly.vertices]
    w = poly_3d_calc(cos, h[0])
    u = sum(wi * uv_layer[li].uv.x for wi, li in zip(w, poly.loop_indices))
    v = sum(wi * uv_layer[li].uv.y for wi, li in zip(w, poly.loop_indices))
    return (u, v)


# Plain paint (the belly aft of the main bays) and the dark well lining (the main well's floor).
PAINT_UV = skin_uv(-1.6, 0.0)
WELL_UV = skin_uv(0.48, 0.5)


def closed_door_bvh():
    bm = bmesh.new()
    for name, p in parts.items():
        if p['driver'] != 'gear' or not p.get('keepVisible'):
            continue
        m = hinge_rotation(p['pivot'], p['axis'], math.degrees(p['travelRad']))
        for o in groups.get(name, []):
            me = o.data.copy()
            me.transform(m)
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


LID_STEP = 0.02


def find_openings(doors, x0, x1, z0, z1):
    """Cells of the box where the first surface seen from below is the well's lining (polygons
    outside the skin's big UV islands: the source maps the wells' floors and walls as small
    islands of their own), not the skin or a closed door. Also returns the visible surface's
    height per cell."""
    xs = [x0 + i * LID_STEP for i in range(int((x1 - x0) / LID_STEP) + 1)]
    zs = [z0 + k * LID_STEP for k in range(int((z1 - z0) / LID_STEP) + 1)]
    hit, rec = {}, set()
    for i, x in enumerate(xs):
        for k, z in enumerate(zs):
            a = skin_hit(x, z)
            b = doors.ray_cast(blend((x, -4.0, z)), blend((0, 1, 0)))
            if b[0] is not None and (a is None or body(b[0]).y <= a[0].y + 0.002):
                hit[(i, k)] = (body(b[0]).y, True)
            elif a is not None:
                hit[(i, k)] = (a[0].y, False)
                if ISLAND_SIZE[ISLAND[a[1]]] < 20:
                    rec.add((i, k))
    return xs, zs, rec, hit


def components2(cells):
    seen, out = set(), []
    for c in cells:
        if c in seen:
            continue
        comp, stack = [], [c]
        seen.add(c)
        while stack:
            i, k = stack.pop()
            comp.append((i, k))
            for n in ((i + 1, k), (i - 1, k), (i, k + 1), (i, k - 1)):
                if n in cells and n not in seen:
                    seen.add(n)
                    stack.append(n)
        out.append(comp)
    return out


def panel(name, cells, xs, zs, y_of, uv_of, proud):
    """A skin-following panel over the given grid cells (each LID_STEP square), `proud` below the
    skin, its texture from uv_of(x, z)."""
    half = LID_STEP / 2
    vid, vb, uvs, faces = {}, [], [], []

    def vert(x, z):
        key = (round(x, 4), round(z, 4))
        if key not in vid:
            y = y_of(x, z)
            vid[key] = len(vb)
            vb.append(Vector((x, (y if y is not None else -0.5) - proud, z)))
            uvs.append(uv_of(x, z) or PAINT_UV)
        return vid[key]
    for (i, k) in cells:
        x, z = xs[i], zs[k]
        faces.append((vert(x - half, z - half), vert(x + half, z - half), vert(x + half, z + half), vert(x - half, z + half)))
    me = bpy.data.meshes.new(name)
    me.from_pydata([blend(v) for v in vb], [], faces)
    me.update()
    for poly in me.polygons:
        if body(poly.normal).y > 0:  # face down (outwards)
            poly.flip()
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for vi, li in zip(poly.vertices, poly.loop_indices):
            uvl.data[li].uv = uvs[vi]
    me.materials.append(main.data.materials[0])
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def skin_y_near(x, z):
    """Skin height at (x, z), or at the nearest skin found searching outwards in z."""
    for dz in (0.0, 0.03, -0.03, 0.06, -0.06, 0.1, -0.1, 0.15, -0.15, 0.2, -0.2):
        h = skin_hit(x, z + dz)
        if h is not None:
            return h[0].y
    return None


def uv_islands(me):
    """Polygon index -> island id: polygons joined across edges whose two sides share their UVs."""
    bm = bmesh.new()
    bm.from_mesh(me)
    uvl = bm.loops.layers.uv.active
    par = list(range(len(bm.faces)))

    def f(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for e in bm.edges:
        lf = e.link_loops
        if len(lf) != 2:
            continue
        a, b = lf
        # a runs v0->v1 in its face, b runs v1->v0: matching UVs at both ends = no seam.
        if (a[uvl].uv - b.link_loop_next[uvl].uv).length < 1e-5 and (a.link_loop_next[uvl].uv - b[uvl].uv).length < 1e-5:
            ra, rb = f(a.face.index), f(b.face.index)
            if ra != rb:
                par[ra] = rb
    out = [f(i) for i in range(len(bm.faces))]
    bm.free()
    return out


ISLAND = uv_islands(main.data)
from collections import Counter
ISLAND_SIZE = Counter(ISLAND)


# Bay lids: whatever of the main wells stays open with the gear up gets a flush, painted lid that
# opens 90 deg with the gear, hinged on its outboard edge (as the Tejas's, blender_tejas.py 5b).
# Authored open, as every gear part is; the gear's travel closes it.
doors_closed = closed_door_bvh()
for side, sgn in (('R', 1), ('L', -1)):
    za, zb = (0.2, 1.05) if sgn > 0 else (-1.05, -0.2)
    xs, zs, rec, seen = find_openings(doors_closed, -1.2, 1.0, za, zb)
    comps = [c for c in components2(rec) if len(c) >= 40]
    print('MAIN WELL', side, len(rec), 'open cells in', len(comps), 'openings')
    for n, comp in enumerate(sorted(comps, key=len, reverse=True)):
        cells = set(comp)
        # Lid height: along each fore-and-aft line, the visible surface (skin or closed door) just
        # ahead of and behind the opening, interpolated; then smoothed across the lines.
        raw = {}
        for k in {k for (_, k) in cells}:
            col = sorted(i for (i, kk) in cells if kk == k)
            i0, i1 = col[0] - 1, col[-1] + 1
            ya = seen.get((i0, k), (None,))[0]
            yb = seen.get((i1, k), (None,))[0]
            if ya is None or yb is None:
                ya = yb = ya if yb is None else yb
            for i in col:
                t = (i - i0) / (i1 - i0)
                raw[(i, k)] = (ya if ya is not None else -0.5) * (1 - t) + (yb if yb is not None else -0.5) * t
        smooth = {}
        for (i, k) in raw:
            nb = [raw[(i + di, k + dk)] for di in range(-4, 5) for dk in range(-5, 6) if (i + di, k + dk) in raw]
            smooth[(i, k)] = sum(nb) / len(nb)

        def lid_y(x, z, _xs=xs, _zs=zs, _sm=smooth):
            # A corner takes the mean of the cells meeting at it (so neighbouring cells share one
            # height there: no steps); a cell centre takes its own.
            near = [(i, k) for (i, k) in _sm if abs(_xs[i] - x) <= LID_STEP * 0.51 and abs(_zs[k] - z) <= LID_STEP * 0.51]
            if near:
                return sum(_sm[c] for c in near) / len(near)
            return _sm[min(_sm, key=lambda c: (_xs[c[0]] - x) ** 2 + (_zs[c[1]] - z) ** 2)]
        name = 'mainLid%s%d' % (side, n)
        o = panel(name, cells, xs, zs, lid_y, lambda x, z: PAINT_UV, 0.004)
        for poly in o.data.polygons:
            poly.use_smooth = True
        zs_c = [zs[k] for (_, k) in cells]
        xs_c = [xs[i] for (i, _) in cells]
        zh = max(zs_c) + LID_STEP / 2 if sgn > 0 else min(zs_c) - LID_STEP / 2
        x0 = min(xs_c)
        pivot = Vector((x0, (lid_y(x0, zh) or -0.5) - 0.003, zh))
        # + about this axis swings the free (inboard) edge down (open); the gear's travel closes it.
        axis = Vector((-1.0 if sgn > 0 else 1.0, 0, 0))
        o.data.transform(hinge_rotation(pivot, axis, 90))
        groups[name] = [o]
        parts[name] = dict(driver='gear', pivot=pivot, axis=axis, travelRad=-90 * deg, keepVisible=True, window=[0.7, 1.0])
        print('LID', name, len(cells), 'cells, x %.2f..%.2f z %.2f..%.2f' % (min(xs_c), max(xs_c), min(zs_c), max(zs_c)))

# Speed brakes: the two belly panels each side of the centreline ahead of the nozzle shroud
# (x -3.53..-4.23, |z| <= 0.52, measured off the source's panel lines), hinged at their front edge
# and opening 50 deg down. Skin-following panels carrying the skin's own texture, over a dark recess.
SB_X0, SB_X1, SB_Z = -4.2, -3.55, 0.5


def sb_y(x, z):
    h = skin_hit(x, z)
    return h[0].y if h is not None else skin_y_near(x, z)


for side, sgn in (('R', 1), ('L', -1)):
    xs = [SB_X0 + i * LID_STEP for i in range(int((SB_X1 - SB_X0) / LID_STEP) + 1)]
    zs = [sgn * (0.02 + k * LID_STEP) for k in range(int((SB_Z - 0.02) / LID_STEP) + 1)]
    cells = {(i, k) for i in range(len(xs)) for k in range(len(zs))}
    groups['body'].append(panel('speedBrakeWell' + side, cells, xs, zs, sb_y, lambda x, z: WELL_UV, 0.001))
    name = 'speedBrake' + side
    groups[name] = [panel(name, cells, xs, zs, sb_y, skin_uv, 0.005)]
    front = max(xs) + LID_STEP / 2
    pivot = Vector((front, sb_y(front - 0.01, sgn * SB_Z / 2) - 0.005, 0.0))
    # + about +z swings the trailing edge down.
    parts[name] = dict(driver='airbrake', pivot=pivot, axis=Vector((0, 0, 1)), travelRad=math.radians(50))
    print('SPEED BRAKE', side, 'hinge x %.2f y %.2f' % (pivot.x, pivot.y))

# --- 6. Scene data: pylons, lights, nozzle, canopy box. ---
bm = bmesh.new()
bm.from_mesh(main.data)
airframe = BVHTree.FromBMesh(bm)
bm.free()


def under_y(x, z):
    """y of the airframe's lower surface over (x, z), or None."""
    h = airframe.ray_cast(blend((x, -4.0, z)), blend((0, 1, 0)))
    return None if h[0] is None else body(h[0]).y


# The pylons and wingtip rails are loose pieces of the airframe: per side, the rail at the tip and
# the two underwing pylons' lower (launcher) halves, sorted outboard to inboard.
cs = components(main)
mv = verts(main)
tip_z = max(abs(v.z) for v in mv)
low = [c for c in cs if c['n'] < 200 and c['mx'].x - c['mn'].x > 1.8 and c['mx'].z - c['mn'].z < 0.2 and abs(c['mn'].z + c['mx'].z) / 2 > 1.5]
pylons = []
by_side = {}
for c in low:
    zc = (c['mn'].z + c['mx'].z) / 2
    by_side.setdefault('r' if zc > 0 else 'l', []).append(c)
for s, lst in by_side.items():
    # One per station: the lowest piece at each spanwise position (the launcher under its fairing).
    stations = {}
    for c in sorted(lst, key=lambda c: c['mn'].y):
        zc = round(abs(c['mn'].z + c['mx'].z) / 2, 1)
        if not any(abs(zc - k) < 0.3 for k in stations):
            stations[zc] = c
    ordered = sorted(stations.items(), key=lambda kv: -kv[0])
    print('PYLON PIECES', s, [(k, tuple(round(x, 2) for x in c['mn']), tuple(round(x, 2) for x in c['mx'])) for k, c in ordered])
    for (zc, c), name in zip(ordered, ('outer', 'mid', 'inner')):
        x0, x1 = c['mn'].x, c['mx'].x
        z = (c['mn'].z + c['mx'].z) / 2
        if name == 'outer':
            # The wingtip launcher: missiles slide on the source's own rail (no rail of ours).
            pylons.append(dict(stationId='wing-outer-' + s, x=round((x0 + x1) / 2 - 0.25, 3), z=round(z, 3), len=round(x1 - x0, 3),
                               attachY=round(c['mn'].y, 3), rail=False))
        else:
            pylons.append(dict(stationId='wing-%s-%s' % (name, s), x=round((x0 + x1) / 2 + 0.2, 3), z=round(z, 3), len=round(x1 - x0, 3),
                               attachY=round(c['mn'].y, 3)))
order = ['wing-outer-l', 'wing-outer-r', 'wing-mid-l', 'wing-mid-r', 'wing-inner-l', 'wing-inner-r']
pylons.sort(key=lambda p: order.index(p['stationId']))
assert [p['stationId'] for p in pylons] == order, [p['stationId'] for p in pylons]
# The centreline station: the source has no pylon there, so a generated one (a streamlined slab,
# as the Tejas's) under the belly between the main legs, the store hanging from its lower edge.
CL_X0, CL_X1, CL_DEPTH = -0.5, 0.9, 0.15


def add_body_box(x0, x1, y_top, y_bot, half_w, nose=0.25, tail=0.2):
    """A streamlined pylon (rounded slab, tapered at both ends) joined to the airframe."""
    nx, nr = 12, 12
    vb, faces = [], []
    for i in range(nx + 1):
        x = x0 + (x1 - x0) * i / nx
        k = min(1.0, (x - x0) / tail, (x1 - x) / nose)
        k = max(0.15, math.sqrt(max(0.0, k)))
        for j in range(nr):
            a = 2 * math.pi * j / nr
            ca, sa = math.cos(a), math.sin(a)
            z = half_w * k * math.copysign(abs(ca) ** 0.5, ca)
            y = (y_top + y_bot) / 2 + (y_top - y_bot) / 2 * math.copysign(abs(sa) ** 0.5, sa)
            vb.append(blend((x, y, z)))
    for i in range(nx):
        for j in range(nr):
            a, b = i * nr + j, i * nr + (j + 1) % nr
            faces.append((a, b, b + nr, a + nr))
    faces.append(tuple(range(nr)))
    faces.append(tuple(nx * nr + j for j in reversed(range(nr))))
    me = bpy.data.meshes.new('pylonGen')
    me.from_pydata(vb, [], faces)
    me.update()
    bm2 = bmesh.new()
    bm2.from_mesh(me)
    bmesh.ops.triangulate(bm2, faces=bm2.faces[:])
    bmesh.ops.recalc_face_normals(bm2, faces=bm2.faces[:])
    bm2.to_mesh(me)
    bm2.free()
    uvl = me.uv_layers.new(name='UVMap')
    for lp in uvl.data:
        lp.uv = PAINT_UV
    me.materials.append(main.data.materials[0])
    o = bpy.data.objects.new('pylonGen', me)
    bpy.context.scene.collection.objects.link(o)
    groups['body'].append(o)


belly = min(y for y in (under_y(x, 0.0) for x in (CL_X0 + 0.1, (CL_X0 + CL_X1) / 2, CL_X1 - 0.1)) if y is not None)
add_body_box(CL_X0, CL_X1, belly + 0.04, belly - CL_DEPTH, 0.055)
pylons.append(dict(stationId='centreline', x=round((CL_X0 + CL_X1) / 2, 3), z=0.0, len=round(CL_X1 - CL_X0, 3), attachY=round(belly - CL_DEPTH, 3)))
print('CENTRELINE PYLON belly y', round(belly, 3))
# A flush pod mount under the port intake.
pod_y = under_y(1.6, -0.62)
pod_mount = [1.6, round((pod_y if pod_y is not None else belly) - 0.02, 3), -0.62]

tipv = [v for v in mv if v.z > tip_z - 0.06]
tip = max(tipv, key=lambda v: v.y)
tip_front = max(v.x for v in tipv)
tip_rear = min(v.x for v in tipv)
fin = [v for v in mv if abs(v.z) < 0.05]
fin_top_y = max(v.y for v in fin)
fin_aft = min([v for v in fin if v.y > fin_top_y - 0.25], key=lambda v: v.x)
nose_top = parts['noseGear']['pivot']
# The navigation lights sit on the wing's leading edge just inboard of the wingtip launcher (a
# missile on the launcher hangs where a lamp on the launcher's nose would be).
rail_in = min(abs(p['z']) for p in pylons if p['stationId'].startswith('wing-outer')) - 0.1
nav_band = [v for v in mv if rail_in - 0.12 < v.z < rail_in]
nav_le = max(nav_band, key=lambda v: v.x)
nav_y = max(v.y for v in nav_band if abs(v.x - nav_le.x) < 0.12)
nav = [round(nav_le.x - 0.06, 3), round(nav_y + 0.01, 3), round(rail_in - 0.06, 3)]
print('NAV LIGHTS', nav)
lights = dict(
    navLeft=[nav[0], nav[1], -nav[2]], navRight=[nav[0], nav[1], nav[2]],
    navTail=[round(fin_aft.x - 0.005, 3), round(fin_aft.y - 0.04, 3), 0], strobeLeft=[round(tip_rear + 0.08, 3), round(tip.y + 0.03, 3), -round(tip.z, 3)],
    strobeRight=[round(tip_rear + 0.08, 3), round(tip.y + 0.03, 3), round(tip.z, 3)], landing=[round(nose_top.x + 0.1, 3), round(nose_top.y - 0.45, 3), 0],
    landingDir=[math.cos(0.07), -math.sin(0.07), 0])

# The nozzle: its axis from the exit lip; cut out everything aft of the shroud inside the petals'
# radius (petals, lip, the painted turbine face), recording its shape for the renderer's own.
tail_x = min(v.x for v in mv)
lip = [v for v in mv if v.x < tail_x + 0.06 and abs(v.z) < 0.8]
axis_y = (min(v.y for v in lip) + max(v.y for v in lip)) / 2
nozzle = dict(exitX=round(tail_x, 3), axisY=round(axis_y, 3))
NOZ_CUT_X = tail_x + 0.85
NOZ_CUT_R = 0.6


def _noz_r(v):
    return math.hypot(v.y - axis_y, v.z)


bm = bmesh.new()
bm.from_mesh(main.data)
cut = [f for f in bm.faces if all(body(v.co).x < NOZ_CUT_X and _noz_r(body(v.co)) < NOZ_CUT_R for v in f.verts)]
cut += [f for f in bm.faces if f not in cut and all(body(v.co).x < NOZ_CUT_X + 0.1 for v in f.verts)
        and _noz_r(body(f.calc_center_median())) < 0.3]
cut_v = [body(v.co) for f in cut for v in f.verts]
lip_v = [v for v in cut_v if v.x < nozzle['exitX'] + 0.03]
petal_v = [v for v in cut_v if v.x < NOZ_CUT_X]
hinge = [v for v in petal_v if v.x > max(c.x for c in petal_v) - 0.03]
nozzle['hingeX'] = round(max(v.x for v in petal_v), 3)
print('HINGE RADII', sorted(set(round(_noz_r(v), 2) for v in hinge)))
nozzle['hingeR'] = round(max(_noz_r(v) for v in hinge), 3)
nozzle['exitR'] = round(max(_noz_r(v) for v in lip_v), 3)
bmesh.ops.delete(bm, geom=cut, context='FACES')
bm.to_mesh(main.data)
bm.free()
print('NOZZLE CUT', len(cut), 'faces;', nozzle)
gl = all_verts(['canopyGlass', 'windscreen'])
canopy_box = dict(min=[round(min(v.x for v in gl), 3), round(min(v.y for v in gl) - 0.1, 3), -0.45], max=[round(max(v.x for v in gl), 3), round(max(v.y for v in gl), 3), 0.45])


# --- 7. Join groups into named objects, attach extras, export. ---
def join(name, names):
    objs = [o for n in names for o in groups.get(n, [])]
    if not objs:
        return None
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


keep = {join('body', ['body', 'canopyFrame']), join('glass', ['canopyGlass', 'windscreen'])}
for name, p in parts.items():
    o = join(name, [name])
    if o is None:
        print('MISSING PART', name)
        continue
    o['driver'] = p['driver']
    o['pivot'] = [round(c, 4) for c in p['pivot']]
    o['axis'] = [round(c, 5) for c in p['axis']]
    o['travelRad'] = round(p['travelRad'], 5)
    if p.get('keepVisible'):
        o['keepVisible'] = True
    if p.get('parent'):
        o['parent'] = p['parent']
    if p.get('radius'):
        o['radiusM'] = round(p['radius'], 4)
    if p['driver'] == 'gear':
        o['travelWindow'] = p.get('window') or ([0.7, 1.0] if p.get('keepVisible') else [0.0, 0.75])
    keep.add(o)
    print('PART', name, o['driver'], list(o['pivot']), list(o['axis']), round(math.degrees(o['travelRad']), 1))
for o in list(bpy.data.objects):
    if o not in keep:
        bpy.data.objects.remove(o)

sc = bpy.context.scene
sc['marut'] = dict(pylons=pylons, podMount=pod_mount, lights=lights, nozzle=nozzle, canopyInterior=canopy_box,
                   credit='"JF-17" by dimal965 (https://sketchfab.com/3d-models/jf-17-b57660f346314df1877e15b85d6e74be), CC BY 4.0; rigged for Marut')
print('PYLONS', pylons)
print('PODMOUNT', pod_mount)
print('LIGHTS', lights)
print('NOZZLE', nozzle, 'CANOPY', canopy_box)

# Textures: the resized set from build_jf17.py (the glass keeps its own tiny maps).
for m in bpy.data.materials:
    if not m.use_nodes or 'glass' in m.name.lower():
        continue
    for node in m.node_tree.nodes:
        if node.type == 'TEX_IMAGE' and node.image:
            low_name = node.image.name.lower()
            for key, fn in (('basecolor', 'baseColor.png'), ('metallicroughness', 'metallicRoughness.png'), ('normal', 'normal.png')):
                if key in low_name:
                    cs_name = node.image.colorspace_settings.name
                    node.image = bpy.data.images.load(TEX_DIR + '/' + fn)
                    node.image.colorspace_settings.name = cs_name
                    print('TEXTURE', key, '->', fn)
for m in bpy.data.materials:
    m.use_backface_culling = True

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_extras=True, export_tangents=True, export_yup=True,
                          export_image_format='JPEG', export_jpeg_quality=88, export_animations=False, export_skins=False,
                          export_morph=False, export_cameras=False, export_lights=False)
print('WROTE', OUT)
