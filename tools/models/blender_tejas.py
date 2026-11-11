"""
tools/models/blender_tejas.py - Blender (headless) half of the Tejas model build (build_tejas.py
runs it). Turns the Sketchfab "HAL Tejas" by dimal965 (CC BY 4.0) into the GLB the renderer loads:

- moves it into the sim's body frame (x forward, y up, z right; glTF export makes Blender's
  X/Y/Z = body x/-z/y): radome tip at body x 7.55, static wheel bottoms at body y -1.62 - the
  same datums as the procedural model (render/aircraftModels/tejasModel.ts), so the main wheels
  land on the physics' main gear;
- splits the welded mesh into its loose pieces and sorts them (by bounding box) into the fixed
  airframe, the cockpit (hidden from inside the 3D cockpit), glass, and the moving parts;
- closes the canopy and the airbrakes (the source is posed parked: canopy up, brakes out);
- finds each moving part's hinge (pivot + unit axis, body frame, signs as the procedural model's)
  and writes it, the pylons, lights, nozzle and canopy box into glTF extras.

Usage: blender -b --factory-startup --python blender_tejas.py -- <scene.gltf> <textures dir> <out.glb>
"""
import math
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index('--') + 1:]
SRC, TEX_DIR, OUT = args[0], args[1], args[2]

RADOME_TIP_X = 7.55
WHEEL_BOTTOM_Y = -1.62

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)


def body(v):
    """Blender coords (after the frame change) -> body frame (x, y, z)."""
    return Vector((v.x, v.z, -v.y))


def blend(p):
    """Body frame -> Blender coords."""
    return Vector((p[0], -p[2], p[1]))


# --- 1. Frame: bake every object's transform, then rotate +90 deg about Z (nose from -Y to +X). ---
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
rot = Matrix.Rotation(math.radians(90), 4, 'Z')
for o in meshes:
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = Matrix.Identity(4)
    o.data.transform(rot @ mw)
for o in [o for o in bpy.data.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)

# --- 2. Pieces: faces connected through shared vertex POSITIONS (UV seams split the vertices, so
# Blender's own "separate loose" cuts pieces along their texture seams). ---
def components(o):
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
    out = []
    for faces in comps.values():
        bm.faces.ensure_lookup_table()
        vs = [body(v.co) for fi in faces for v in bm.faces[fi].verts]
        mn = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
        mx = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
        out.append(dict(obj=o, faces=faces, mn=mn, mx=mx, n=len(faces)))
    bm.free()
    return out


comps = [c for o in meshes for c in components(o)]

# Datums: the pitot is the most forward piece; the radome tip is the furthest-forward point of the rest.
pitot = max(comps, key=lambda c: c['mx'].x)
radome_x = max(c['mx'].x for c in comps if c is not pitot)
bottom_y = min(c['mn'].y for c in comps)
d_body = Vector((RADOME_TIP_X - radome_x, WHEEL_BOTTOM_Y - bottom_y, 0))
for o in meshes:
    o.data.transform(Matrix.Translation(blend(d_body)))
for c in comps:
    c['mn'] += d_body
    c['mx'] += d_body


# --- 2b. Symmetry: the source poses some left-side pieces differently from their right twins
# (slats drooped, slat-strut relief panels open under the wing, the main leg a few cm off). Every
# left piece with an identical mirrored twin on the right is moved onto that twin's mirror image. ---
def _kabsch(a, b):
    ca, cb = a.mean(0), b.mean(0)
    u, _, vt = np.linalg.svd((a - ca).T @ (b - cb))
    d = np.sign(np.linalg.det(vt.T @ u.T))
    r = vt.T @ np.diag([1.0, 1.0, d]) @ u.T
    return r, cb - r @ ca


def _icp(a, b, iters=40):
    r, t = np.eye(3), b.mean(0) - a.mean(0)
    for _ in range(iters):
        q = a @ r.T + t
        nn = b[np.argmin(((q[:, None, :] - b[None, :, :]) ** 2).sum(2), axis=1)]
        r, t = _kabsch(a, nn)
    q = a @ r.T + t
    rms = float(np.sqrt(((q[:, None, :] - b[None, :, :]) ** 2).sum(2).min(1).mean()))
    return r, t, rms


def _comp_vidx(c):
    me = c['obj'].data
    return sorted({vi for fi in c['faces'] for vi in me.polygons[fi].vertices})


def _centre(c):
    return (c['mn'] + c['mx']) / 2


# The source's centreline is a few cm off z = 0: find it from the twin pairs' midpoints and shift the
# model onto it (so mirroring through z = 0 doesn't open gaps on the left).
rights = [c for c in comps if _centre(c).z > 0.3 and c['n'] <= 400]
mids = []
for c in comps:
    cc = _centre(c)
    if cc.z > -0.3 or c['n'] > 400:
        continue
    tw = [r for r in rights if r['n'] == c['n'] and (_centre(r) - Vector((cc.x, cc.y, -cc.z))).length < 0.4]
    if tw:
        mids.append((_centre(min(tw, key=lambda r: (_centre(r) - Vector((cc.x, cc.y, -cc.z))).length)).z + cc.z) / 2)
z_mid = sorted(mids)[len(mids) // 2] if mids else 0.0
print('SYMMETRY plane at z %.4f from %d pairs; recentring' % (z_mid, len(mids)))
for o in meshes:
    o.data.transform(Matrix.Translation(blend((0, 0, -z_mid))))
for c in comps:
    c['mn'].z -= z_mid
    c['mx'].z -= z_mid

moved = 0
for c in comps:
    cc = _centre(c)
    if cc.z > -0.3 or c['n'] > 400:
        continue
    twins = [r for r in rights if r['n'] == c['n'] and (_centre(r) - Vector((cc.x, cc.y, -cc.z))).length < 0.4]
    if not twins:
        continue
    tw = min(twins, key=lambda r: (_centre(r) - Vector((cc.x, cc.y, -cc.z))).length)
    li = _comp_vidx(c)
    a = np.array([tuple(c['obj'].data.vertices[i].co) for i in li])
    b = np.array([tuple(tw['obj'].data.vertices[i].co) for i in _comp_vidx(tw)]) * np.array([1.0, -1.0, 1.0])  # body z = -Blender y
    if len(a) != len(b):
        continue
    r, t, rms = _icp(a, b)
    ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(r) - 1) / 2))))
    shift = float(np.abs(a @ r.T + t - a).max())
    if rms > 0.002 or shift < 0.004:
        continue
    q = a @ r.T + t
    for i, vi in enumerate(li):
        c['obj'].data.vertices[vi].co = Vector(tuple(q[i]))
    vs = [body(Vector(tuple(p))) for p in q]
    c['mn'] = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    c['mx'] = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    moved += 1
    print('SYMMETRY moved left piece at', tuple(round(x, 2) for x in cc), 'n', c['n'], 'rot %.1f deg, max shift %.3f m' % (ang, shift))
print('SYMMETRY', moved, 'left pieces moved onto their right twins')


# --- 3. Sort the pieces. ---
def is_glass(o):
    return 'glass' in o.data.materials[0].name.lower()


def classify(c, main):
    mn, mx, n = c['mn'], c['mx'], c['n']
    ext = mx - mn
    cc = (mn + mx) / 2
    side = 'R' if cc.z > 0 else 'L'
    az = abs(cc.z)
    if c is main:
        return 'body'
    if is_glass(c['obj']):
        return 'canopyGlass' if mn.x < 4.0 else 'windscreen'
    if mx.y > 1.6 and 2.5 < cc.x < 4.5:
        return 'canopyFrame'
    if mn.x > 2.8 and mx.x < 4.7 and mn.y > -0.2 and mx.y < 1.25 and max(abs(mn.z), abs(mx.z)) < 0.45:
        return 'cockpit'
    if mn.x > 3.2 and mx.x < 4.7 and ext.x > 0.8 and ext.z < 0.15 and mn.y < -0.3:
        return 'noseDoor' + side
    if mn.x > 1.9 and mx.x < 3.7 and mn.y > -1.7 and mx.y < -0.3 and max(abs(mn.z), abs(mx.z)) < 0.32:
        return ('noseAftDoor' + side) if ext.z < 0.06 and az > 0.15 else 'noseGear'
    if mn.x > -1.7 and mx.x < 0.35 and mn.y > -1.7 and mx.y < 0.06 and 0.15 < az < 1.3 and min(abs(mn.z), abs(mx.z)) > 0.15:
        return ('mainBayDoor' + side) if ext.x > 0.9 and mx.y > -0.05 and n >= 100 else ('mainGear' + side)
    if -3.6 < cc.x < -2.9 and mn.y > 0.3 and n >= 60:
        return 'airbrake' + side
    if -3.95 < cc.x < -3.15 and 0.3 < cc.y < 0.75 and 0.15 < az < 0.7:
        return 'airbrakeAct' + side
    if ext.y < 0.2 and mx.x < -2.9 and mn.x < -3.7 and az > 0.75:
        return ('elevon%s1' if az > 2.0 else 'elevon%s0') % side
    if ext.z > 0.5 and ext.y < 0.35 and ext.x > 0.8 and mx.x > -2.6 and az > 1.6:
        return 'slat%s%d' % (side, 0 if az < 2.3 else 1 if az < 3.0 else 2)
    if mx.x < -3.9 and mn.y > 0.7 and ext.z < 0.15 and ext.y > 1.0 and n < 40:
        return 'rudder'
    if ext.z < 0.2 and mx.y < 0.0 and ext.x > 1.0 and az > 1.2:
        return 'pylon'
    return 'body'


main_c = max(comps, key=lambda c: c['n'])
pylon_boxes = []
labels = {}
for c in comps:
    lab = classify(c, main_c)
    if lab == 'pylon':
        if c['mx'].y > -0.1:
            # The pylon itself (it meets the wing): part of the airframe, and a store station.
            pylon_boxes.append((c['mn'].copy(), c['mx'].copy()))
            lab = 'body'
        else:
            # A missile launcher/rail built under the pylon (inboard and outboard stations): dropped;
            # the renderer hangs the right launcher for whatever the station carries.
            lab = 'launcherRail'
    c['label'] = lab
    labels.setdefault(c['obj'].name, {})
    for fi in c['faces']:
        labels[c['obj'].name][fi] = lab
# Wheels: each leg's tyres (big round pieces reaching the ground) and everything inside them (hubs,
# brakes) become their own parts, riding on the leg and rolling with the ground speed.
WHEEL_LABEL = {'noseGear': 'noseWheels', 'mainGearR': 'mainWheelR', 'mainGearL': 'mainWheelL'}
for gl, wl in WHEEL_LABEL.items():
    leg = [c for c in comps if c['label'] == gl]
    tyres = [c for c in leg if c['n'] >= 100 and (c['mx'] - c['mn']).x > 0.3 and (c['mx'] - c['mn']).y > 0.3 and c['mn'].y < WHEEL_BOTTOM_Y + 0.03]
    for t in tyres:
        lo = t['mn'] - Vector((0.01, 0.01, 0.01))
        hi = t['mx'] + Vector((0.01, 0.01, 0.01))
        for c in leg:
            if all(lo[i] <= c['mn'][i] and c['mx'][i] <= hi[i] for i in range(3)):
                c['label'] = wl
                for fi in c['faces']:
                    labels[c['obj'].name][fi] = wl
for lab in sorted({c['label'] for c in comps}):
    sel = [c for c in comps if c['label'] == lab]
    print('GROUP', lab, len(sel), sum(c['n'] for c in sel))

# Split each source mesh by label (one separate per label).
groups = {}
for o in meshes:
    lab_of = labels[o.name]
    attr = o.data.attributes.new('grp', 'INT', 'FACE')
    names = sorted(set(lab_of.values()))
    for i, poly in enumerate(o.data.polygons):
        attr.data[i].value = names.index(lab_of[i])
    keep_lab = max(names, key=lambda l: sum(1 for v in lab_of.values() if v == l))
    for li, lab in enumerate(names):
        if lab == keep_lab:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_mode(type='FACE')
        bpy.ops.mesh.select_all(action='DESELECT')
        bpy.ops.object.mode_set(mode='OBJECT')
        for poly in o.data.polygons:
            poly.select = o.data.attributes['grp'].data[poly.index].value == li
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.separate(type='SELECTED')
        bpy.ops.object.mode_set(mode='OBJECT')
        new = [x for x in bpy.context.selected_objects if x is not o][0]
        groups.setdefault(lab, []).append(new)
    groups.setdefault(keep_lab, []).append(o)
main = groups['body'][0]


def verts(o):
    return [body(v.co) for v in o.data.vertices]


for k in sorted(groups):
    print('GROUP', k, len(groups[k]), sum(len(o.data.polygons) for o in groups[k]))


def all_verts(names):
    return [v for name in names for o in groups.get(name, []) for v in verts(o)]


def transform_group(names, m):
    for name in names:
        for o in groups.get(name, []):
            o.data.transform(m)


# Fuselage surface for fitting closed panels.
bm = bmesh.new()
bm.from_mesh(main.data)
fuselage = BVHTree.FromBMesh(bm)
bm.free()


def fit_angle(names, pivot_b, axis_b, probe, lo, hi, inside_tol=0.01):
    """Angle (deg) about the hinge that brings the `probe` vertices of `names` closest to the fuselage."""
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
            # Inside the airframe (behind the nearest face) is not a closed pose.
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
canopy_deg, canopy_err = fit_angle(['canopyFrame'], canopy_pivot, (0, 0, 1), sill, -100, 10, inside_tol=0.06)
print('CANOPY pivot', canopy_pivot, 'close', canopy_deg, 'deg, sill error', round(canopy_err, 3))
transform_group(['canopyFrame', 'canopyGlass'], hinge_rotation(canopy_pivot, (0, 0, 1), canopy_deg))

# --- 4b. Left slats: posed drooped by up to 45 deg in the source, more than the general symmetry
# pass (2b) is sure to catch: fit each onto its mirrored right twin again, with more iterations. ---
for k in (0, 1, 2):
    lo = groups.get('slatL%d' % k, [])
    ro = groups.get('slatR%d' % k, [])
    if not lo or not ro:
        continue
    a = np.array([tuple(v.co) for o in lo for v in o.data.vertices])
    b = np.array([tuple(v.co) for o in ro for v in o.data.vertices]) * np.array([1.0, -1.0, 1.0])  # body z = -Blender y
    r, t, rms = _icp(a, b, iters=60)
    ang = math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(r) - 1) / 2))))
    print('SLAT L%d -> mirror of R%d: rotate %.1f deg, move %.3f m, rms %.4f m' % (k, k, ang, float(np.linalg.norm(t + r @ a.mean(0) - a.mean(0))), rms))
    if rms < 0.02:
        m = Matrix.Identity(4)
        for i in range(3):
            for j in range(3):
                m[i][j] = float(r[i, j])
            m[i][3] = float(t[i])
        for o in lo:
            o.data.transform(m)

# --- 5. Hinges. ---
deg = math.pi / 180
parts = {}


def end_point(vs, key, pick):
    """The vertex of `vs` at one end (key smallest) chosen by `pick` among those within 4 cm of it."""
    k0 = min(key(v) for v in vs)
    near = [v for v in vs if key(v) < k0 + 0.04]
    return pick(near)


def edge_line(vs, span, chord, front, mid=False):
    """Hinge line along one edge: in 8 bins along `span`, the extreme vertex along `chord` (max if
    `front`, else min); a least-squares line through them. Returns (point at the inner end, unit dir).
    `mid`: use the mean of the bin's vertices within 1.5 cm of that extreme instead (the middle of a
    thick edge, so the line doesn't tilt from the top skin at one end to the bottom at the other)."""
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


for side, sgn in (('R', 1), ('L', -1)):
    # Elevons: hinge along the leading edge (front-most points at the inner and outer ends); +z axis.
    for k in (0, 1):
        name = 'elevon%s%d' % (side, k)
        vs = all_verts([name])
        inner, d = edge_line(vs, lambda v: abs(v.z), lambda v: v.x, True)
        parts[name] = dict(driver='elevon' + side, pivot=inner, axis=unit_pos_z(d), travelRad=0)
    # Slats: hinge along the trailing edge; +z axis (as the procedural model); droop = negative.
    for k in (0, 1, 2):
        name = 'slat%s%d' % (side, k)
        vs = all_verts([name])
        if not vs:
            continue
        inner, d = edge_line(vs, lambda v: abs(v.z), lambda v: v.x, False, mid=True)
        parts[name] = dict(driver='slat', pivot=inner, axis=unit_pos_z(d), travelRad=-18 * deg)

    # Airbrake: hinged along its forward edge (it opens up and out into the airflow); close it onto
    # the fuselage, open = that angle back.
    vs = all_verts(['airbrake' + side])
    xmax = max(v.x for v in vs)
    low = [v for v in vs if v.x > xmax - 0.03]
    a0, a1 = max(((p, q) for p in low for q in low), key=lambda pq: (pq[0] - pq[1]).length)
    pivot = (a0 + a1) / 2
    axis = (a1 - a0).normalized()
    far = sorted(vs, key=lambda v: -(v - pivot).cross(axis).length)[: max(4, len(vs) // 4)]
    close_deg, err = fit_angle(['airbrake' + side], pivot, axis, far, -100, 100)
    print('AIRBRAKE', side, 'close', close_deg, 'err', round(err, 3))
    transform_group(['airbrake' + side, 'airbrakeAct' + side], hinge_rotation(pivot, axis, close_deg))
    # Opening = rotating back the other way; flip the axis so the open travel is positive.
    open_axis = axis if close_deg < 0 else -axis
    parts['airbrake' + side] = dict(driver='airbrake', pivot=pivot, axis=open_axis, travelRad=abs(close_deg) * deg)

    # Main gear: the 1.3 m leg can't fold straight inwards (the wheels would meet under the belly),
    # so it swings aft and in, from the top of the leg into the bay under the doors (x -1.6..-0.5):
    # the shortest rotation taking the leg's direction (top -> wheel centre) to "aft and
    # slightly out", ending with the wheel inside the airframe at the back of the bay.
    vs = all_verts(['mainGear' + side, 'mainWheel' + side])
    top = max(vs, key=lambda v: v.y - 0.3 * abs(v.z))
    ymin = min(v.y for v in vs)
    wheel = [v for v in vs if v.y < ymin + 0.55]
    wc = Vector(((min(v.x for v in wheel) + max(v.x for v in wheel)) / 2, (min(v.y for v in wheel) + max(v.y for v in wheel)) / 2,
                 (min(v.z for v in wheel) + max(v.z for v in wheel)) / 2))
    leg = wc - top
    stow = Vector((-1.0, 0.0, 0.12 * sgn)).normalized()
    g_axis = leg.cross(stow).normalized()
    g_ang = leg.angle(stow)
    print('MAIN GEAR', side, 'wheel centre', tuple(round(c, 3) for c in wc), 'stowed at', tuple(round(c, 3) for c in top + stow * leg.length), 'angle', round(math.degrees(g_ang), 1))
    parts['mainGear' + side] = dict(driver='gear', pivot=Vector((top.x, top.y, top.z)), axis=g_axis, travelRad=g_ang)

# Main bay doors: hinged along their top edge (at the wing root), swinging in and up to close the bay.
for side in ('R', 'L'):
    name = 'mainBayDoor' + side
    if not groups.get(name):
        continue
    sgn = 1 if side == 'R' else -1
    vs = all_verts([name])
    ymax = max(v.y for v in vs)
    topv = [v for v in vs if v.y > ymax - 0.04]
    a0 = min(topv, key=lambda v: v.x)
    a1 = max(topv, key=lambda v: v.x)
    pivot = (a0 + a1) / 2
    axis = (a1 - a0).normalized() * sgn  # ~ +x (R) / -x (L): + = swing inwards
    ymin = min(v.y for v in vs)
    far = [v for v in vs if v.y < ymin + 0.12]
    close_deg, err = fit_angle([name], pivot, axis, far, 0, 150, inside_tol=0.03)
    print('BAY DOOR', side, 'close', close_deg, 'err', round(err, 3))
    parts[name] = dict(driver='gear', pivot=pivot, axis=axis, travelRad=close_deg * deg, keepVisible=True)

# Nose doors: hinged along their top edge (axis along x); travel swings them inwards to horizontal.
for name in [n for n in list(groups) if n.startswith('nose') and 'Door' in n]:
    vs = all_verts([name])
    side = name[-1]
    sgn = 1 if side == 'R' else -1
    ymax = max(v.y for v in vs)
    top = [v for v in vs if v.y > ymax - 0.03]
    x0 = min(v.x for v in vs)
    x1 = max(v.x for v in vs)
    hz = sum(v.z for v in top) / len(top)
    pivot = Vector(((x0 + x1) / 2, ymax, hz))
    bot = min(vs, key=lambda v: v.y)
    d = Vector((0, bot.y - pivot.y, bot.z - pivot.z)).normalized()
    # Angle about +x (R) / -x (L) from the door's hanging direction to horizontal, pointing inwards.
    cur = math.atan2(d.z * sgn, -d.y)  # 0 = straight down, + = outboard
    travel = math.pi / 2 + cur
    parts[name] = dict(driver='gear', pivot=pivot, axis=Vector((sgn, 0, 0)), travelRad=travel, keepVisible=True)

# Nose gear: folds forwards about +z from the top of the oleo.
vs = all_verts(['noseGear'])
oleo = [v for v in vs if abs(v.z) < 0.08]
top = max(oleo, key=lambda v: v.y)
parts['noseGear'] = dict(driver='gear', pivot=Vector((top.x, top.y, 0)), axis=Vector((0, 0, 1)), travelRad=88 * deg)

# Rudder: hinge down the leading edge (top -> bottom); + = trailing edge left.
vs = all_verts(['rudder'])
botv, d = edge_line(vs, lambda v: v.y, lambda v: v.x, True)
parts['rudder'] = dict(driver='rudder', pivot=botv, axis=-d if d.y > 0 else d, travelRad=0)

# Wheel hubs: axle through the tyres' centre, along the principal direction nearest the lateral (z)
# axis (a twin-wheel pair is wider than it is round); rolling radius.
for wl, gl in (('noseWheels', 'noseGear'), ('mainWheelR', 'mainGearR'), ('mainWheelL', 'mainGearL')):
    vs = all_verts([wl])
    if not vs:
        continue
    pts = np.array([tuple(v) for v in vs])
    c = (pts.min(0) + pts.max(0)) / 2
    w, ev = np.linalg.eigh(np.cov((pts - c).T))
    ax = ev[:, int(np.argmax(np.abs(ev[2, :])))]
    ax = ax if ax[2] >= 0 else -ax
    rad = float(np.max(np.linalg.norm(np.cross(pts - c, ax), axis=1)))
    parts[wl] = dict(driver='wheel', pivot=Vector(tuple(c)), axis=Vector(tuple(ax)), travelRad=0, parent=gl, radius=rad)
    print('WHEEL', wl, 'centre', tuple(round(float(x), 3) for x in c), 'axis', tuple(round(float(x), 3) for x in ax), 'r', round(rad, 3))

# --- 5b. Bay lids. The source leaves parts of the wheel wells open with the gear up (inboard of the
# main bay doors; the nose leg's drag-brace slot): find them by ray-casting the belly from below
# against the airframe and the closed doors, and close each with a generated flush door that
# follows the skin's curve and opens with the gear. ---
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


doors_closed = closed_door_bvh()
LID_STEP = 0.02


def belly_hit(x, z):
    """(y of the first surface seen from below, True if it is a closed door) or None."""
    o = blend((x, -3.0, z))
    up = blend((0, 1, 0))
    a = fuselage.ray_cast(o, up)
    b = doors_closed.ray_cast(o, up)
    if a[0] is None and b[0] is None:
        return None
    if b[0] is not None and (a[0] is None or b[3] <= a[3] + 0.002):
        return body(b[0]).y, True
    return body(a[0]).y, False


def find_openings(x0, x1, z0, z1, depth=0.05):
    """Cells (i, k) of the box where the first surface seen from below is the airframe (not a closed
    door) and lies `depth` above the lowest skin in its column of the box: an open well."""
    xs = [x0 + i * LID_STEP for i in range(int((x1 - x0) / LID_STEP) + 1)]
    zs = [z0 + k * LID_STEP for k in range(int((z1 - z0) / LID_STEP) + 1)]
    hit = {(i, k): belly_hit(x, z) for i, x in enumerate(xs) for k, z in enumerate(zs)}
    rec = set()
    for k in range(len(zs)):
        col = [hit[(i, k)][0] for i in range(len(xs)) if hit[(i, k)] is not None]
        if not col:
            continue
        skin = min(col)
        for i in range(len(xs)):
            h = hit[(i, k)]
            if h is not None and not h[1] and h[0] > skin + depth:
                rec.add((i, k))
    return xs, zs, rec


def lid_rect(xs, zs, rec, seed):
    """The connected opening nearest the seed point (x, z) as a rectangle (x0, x1, z0, z1), or None."""
    if not rec:
        return None
    start = min(rec, key=lambda c: (xs[c[0]] - seed[0]) ** 2 + (zs[c[1]] - seed[1]) ** 2)
    seen, best = set(), []
    for c in [start]:
        if c in seen:
            continue
        comp, stack = [], [c]
        seen.add(c)
        while stack:
            i, k = stack.pop()
            comp.append((i, k))
            for n in ((i + 1, k), (i - 1, k), (i, k + 1), (i, k - 1)):
                if n in rec and n not in seen:
                    seen.add(n)
                    stack.append(n)
        if len(comp) > len(best):
            best = comp
    if len(best) < 6:
        return None
    i0 = min(c[0] for c in best)
    i1 = max(c[0] for c in best)
    k0 = min(c[1] for c in best)
    k1 = max(c[1] for c in best)
    return xs[i0] - LID_STEP / 2, xs[i1] + LID_STEP / 2, zs[k0] - LID_STEP / 2, zs[k1] + LID_STEP / 2


def skin_y(x, z, z0, z1):
    """Skin height across an opening: linear between the surfaces seen just outside its two sides."""
    def side(zz, step):
        for _ in range(8):
            h = belly_hit(x, zz)
            if h is not None:
                return h[0]
            zz += step
        return None
    ya = side(z0 - 0.015, -0.01)
    yb = side(z1 + 0.015, 0.01)
    if ya is None or yb is None:
        return ya if yb is None else yb
    return ya + (yb - ya) * (z - z0) / (z1 - z0)


def plain_uv():
    """A plain painted spot of the texture (the belly aft of the main bays) for the lids."""
    uv = main.data.uv_layers.active.data
    for poly in main.data.polygons:
        c = body(poly.center)
        if abs(c.x + 2.3) < 0.15 and abs(c.z) < 0.08 and c.y < -0.3:
            li = poly.loop_indices
            return (sum(uv[i].uv.x for i in li) / len(li), sum(uv[i].uv.y for i in li) / len(li))
    return (0.5, 0.5)


LID_UV = plain_uv()


def make_lid(name, rect, hinge_side):
    """A curved panel over rect (x0, x1, z0, z1), 3 mm proud of the skin, hinged along its z0 or z1
    edge (hinge_side -1 / +1) and opening 90 deg downwards; authored open, as the gear parts are."""
    x0, x1, z0, z1 = rect
    nx = max(2, int((x1 - x0) / 0.05) + 1)
    nz = max(2, int((z1 - z0) / 0.03) + 1)
    vb = []
    for i in range(nx):
        x = x0 + (x1 - x0) * i / (nx - 1)
        for k in range(nz):
            z = z0 + (z1 - z0) * k / (nz - 1)
            y = skin_y(x, z, z0, z1)
            if y is None:
                print('LID', name, 'skipped: no skin around it')
                return
            vb.append(Vector((x, y - 0.003, z)))
    faces = [(i * nz + k, (i + 1) * nz + k, (i + 1) * nz + k + 1, i * nz + k + 1) for i in range(nx - 1) for k in range(nz - 1)]
    me = bpy.data.meshes.new(name)
    me.from_pydata([blend(v) for v in vb], [], faces)
    me.update()
    if body(me.polygons[0].normal).y > 0:  # face down (outwards)
        me.flip_normals()
    uvl = me.uv_layers.new(name='UVMap')
    for lp in uvl.data:
        lp.uv = LID_UV
    me.materials.append(main.data.materials[0])
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    zh = z0 if hinge_side < 0 else z1
    pivot = Vector((x0, skin_y(x0, zh, z0, z1) - 0.003, zh))
    # + rotation about this axis swings the free edge down (open); the part closes by -90 deg.
    axis = Vector((1.0 if hinge_side < 0 else -1.0, 0, 0))
    o.data.transform(hinge_rotation(pivot, axis, 90))
    groups[name] = [o]
    parts[name] = dict(driver='gear', pivot=pivot, axis=axis, travelRad=-90 * deg, keepVisible=True)
    print('LID', name, 'x %.2f..%.2f z %.2f..%.2f, hinge z %.2f' % (x0, x1, z0, z1, zh))


for side, sgn in (('R', 1), ('L', -1)):
    # Forward of the outer bay door, inboard of the fuselage side: the well round the top of the leg.
    za, zb = (0.12, 0.7) if sgn > 0 else (-0.7, -0.12)
    xs, zs, rec = find_openings(-0.8, 0.25, za, zb)
    pv = parts['mainGear' + side]['pivot']
    r = lid_rect(xs, zs, rec, (pv.x, pv.z))
    print('MAIN WELL', side, len(rec), 'open cells', r)
    if r:
        make_lid('mainInnerDoor' + side, r, -1 if sgn > 0 else 1)  # hinged on its inboard edge
xs, zs, rec = find_openings(1.9, 3.05, -0.3, 0.3)
r = lid_rect(xs, zs, rec, (2.7, 0.0))
print('NOSE WELL', len(rec), 'open cells', r)
if r:
    make_lid('noseSlotDoor', r, -1)

# --- 6. Scene data: pylons, lights, nozzle, canopy box. ---
STATION = {('inner', 'L'): 'wing-inner-l', ('inner', 'R'): 'wing-inner-r', ('mid', 'L'): 'wing-mid-l',
           ('mid', 'R'): 'wing-mid-r', ('outer', 'L'): 'wing-outer-l', ('outer', 'R'): 'wing-outer-r'}
clusters = {}
for mn, mx in pylon_boxes:
    c = (mn + mx) / 2
    pos = 'inner' if abs(c.z) < 2.0 else 'mid' if abs(c.z) < 2.9 else 'outer'
    clusters.setdefault((pos, 'R' if c.z > 0 else 'L'), []).append((mn, mx))
pylons = []
for key in [('outer', 'L'), ('outer', 'R'), ('mid', 'L'), ('mid', 'R'), ('inner', 'L'), ('inner', 'R')]:
    boxes = clusters[key]
    # Stores hang from the pylon's base, centred on it (its suspension lugs).
    mn = Vector((min(b[0].x for b in boxes), min(b[0].y for b in boxes), min(b[0].z for b in boxes)))
    mx = Vector((max(b[1].x for b in boxes), max(b[1].y for b in boxes), max(b[1].z for b in boxes)))
    pylons.append(dict(stationId=STATION[key], x=round((mn.x + mx.x) / 2, 3), z=round((mn.z + mx.z) / 2, 3),
                       len=round(mx.x - mn.x, 3), attachY=round(mn.y, 3)))


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
            e = 0.5
            z = half_w * k * math.copysign(abs(ca) ** e, ca)
            y = (y_top + y_bot) / 2 + (y_top - y_bot) / 2 * math.copysign(abs(sa) ** e, sa)
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
        lp.uv = LID_UV
    me.materials.append(main.data.materials[0])
    o = bpy.data.objects.new('pylonGen', me)
    bpy.context.scene.collection.objects.link(o)
    groups['body'].append(o)


# Centreline: no pylon in the source; a generated one under the belly between the main legs.
CL_X0, CL_X1 = -1.05, 0.35
belly = [belly_hit(x, 0.0) for x in (CL_X0, (CL_X0 + CL_X1) / 2, CL_X1)]
belly_y = min(h[0] for h in belly if h is not None) if any(belly) else -0.7
add_body_box(CL_X0, CL_X1, belly_y + 0.03, belly_y - 0.12, 0.06)
pylons.append(dict(stationId='centreline', x=round((CL_X0 + CL_X1) / 2, 3), z=0.0, len=round(CL_X1 - CL_X0, 3), attachY=round(belly_y - 0.12, 3)))

# Sensor pod station under the port intake: the intake's lowest point near x 1.25.
pod_hits = [(belly_hit(1.25, -zz), zz) for zz in (0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7)]
pod_hits = [(h[0], zz) for h, zz in pod_hits if h is not None]
pod_y, pod_z = min(pod_hits) if pod_hits else (-0.75, 0.74)
pod_mount = [1.25, round(pod_y - 0.04, 3), round(-pod_z, 3)]
print('POD MOUNT (port intake)', pod_mount)

mv = verts(main)
tip = max(mv, key=lambda v: v.z)
tipv = [v for v in mv if v.z > tip.z - 0.06]
tip_front = max(v.x for v in tipv)
tip_rear = min(v.x for v in tipv)
fin_top = max(mv, key=lambda v: v.y)
fin_aft = min([v for v in mv if v.y > fin_top.y - 0.12], key=lambda v: v.x)
nose_top = parts['noseGear']['pivot']
lights = dict(
    navLeft=[tip_front - 0.08, tip.y, -tip.z - 0.02], navRight=[tip_front - 0.08, tip.y, tip.z + 0.02],
    navTail=[fin_aft.x - 0.005, fin_aft.y - 0.04, 0], strobeLeft=[tip_rear + 0.08, tip.y, -tip.z - 0.02],
    strobeRight=[tip_rear + 0.08, tip.y, tip.z + 0.02], landing=[nose_top.x + 0.12, nose_top.y - 0.5, 0],
    landingDir=[math.cos(0.07), -math.sin(0.07), 0])
noz = [v for v in verts(main) if v.x < -4.3 and v.y < 0.6 and abs(v.z) < 0.5]
nozzle = dict(exitX=round(min(v.x for v in noz), 3), axisY=round((min(v.y for v in noz) + max(v.y for v in noz)) / 2, 3))

# The source's nozzle (fixed petals and a flat-painted inside) is replaced by the renderer's own
# (petals that open with the engine, heat-blued metal, an interior that glows with power): cut out
# everything aft of the shroud ring inside the petals' radius, and record its shape.
NOZ_CUT_X = -4.5
NOZ_CUT_R = 0.47


def _noz_r(v):
    return math.hypot(v.y - nozzle['axisY'], v.z)


bm = bmesh.new()
bm.from_mesh(main.data)
cut = [f for f in bm.faces if all(body(v.co).x < NOZ_CUT_X and _noz_r(body(v.co)) < NOZ_CUT_R for v in f.verts)]
# ...and the flat disc closing the fuselage end inside the shroud (it would hide the engine face).
cut += [f for f in bm.faces if f not in cut and all(body(v.co).x < NOZ_CUT_X + 0.1 for v in f.verts)
        and _noz_r(body(f.calc_center_median())) < 0.3]
cut_v = [body(v.co) for f in cut for v in f.verts]
lip = [v for v in cut_v if v.x < nozzle['exitX'] + 0.03]
petal_v = [v for v in cut_v if v.x < NOZ_CUT_X]
hinge = [v for v in petal_v if v.x > max(c.x for c in petal_v) - 0.03]
nozzle['hingeX'] = round(max(v.x for v in petal_v), 3)
nozzle['hingeR'] = round(sorted(_noz_r(v) for v in hinge)[len(hinge) * 3 // 4], 3)
nozzle['exitR'] = round(max(_noz_r(v) for v in lip), 3)
bmesh.ops.delete(bm, geom=cut, context='FACES')
bm.to_mesh(main.data)
bm.free()
print('NOZZLE CUT', len(cut), 'faces;', nozzle)
gl = all_verts(['canopyGlass', 'windscreen'])
canopy_box = dict(min=[min(v.x for v in gl), min(v.y for v in gl) - 0.1, -0.45], max=[max(v.x for v in gl), max(v.y for v in gl), 0.45])

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


keep = set()
for name in ['body', 'cockpit']:
    o = join(name, [name, 'canopyFrame'] if name == 'cockpit' else [name])
    keep.add(o)
glass = join('glass', ['canopyGlass', 'windscreen'])
keep.add(glass)
for name, p in parts.items():
    o = join(name, [name] + p.get('extra', []))
    if o is None:
        print('MISSING PART', name)
        continue
    o['driver'] = p['driver']
    o['pivot'] = [round(c, 4) for c in p['pivot']]
    o['axis'] = [round(c, 5) for c in p['axis']]
    o['travelRad'] = round(p['travelRad'], 5)
    if p.get('keepVisible'):
        o['keepVisible'] = True
    # Gear timing: legs fold over the first 3/4 of the retraction, then the doors close (reversed on
    # the way down: doors open, then the legs come down).
    if p.get('parent'):
        o['parent'] = p['parent']
        o['radiusM'] = round(p['radius'], 4)
    if p['driver'] == 'gear':
        o['travelWindow'] = [0.7, 1.0] if 'Door' in name else [0.0, 0.75]
    keep.add(o)
    print('PART', name, o['driver'], o['pivot'], o['axis'], round(math.degrees(o['travelRad']), 1))
for o in list(bpy.data.objects):
    if o not in keep:
        bpy.data.objects.remove(o)

sc = bpy.context.scene
sc['marut'] = dict(pylons=pylons, podMount=pod_mount, lights=lights, nozzle=nozzle, canopyInterior=canopy_box,
                   credit='"HAL Tejas" by dimal965 (https://sketchfab.com/3d-models/hal-tejas-fd95c85e2452490cbe32f80175498441), CC BY 4.0; repainted and rigged for Marut')
print('PYLONS', pylons)
print('LIGHTS', lights)
print('NOZZLE', nozzle, 'CANOPY', canopy_box)

# Textures: the repainted / resized set from build_tejas.py.
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    for node in m.node_tree.nodes:
        if node.type == 'TEX_IMAGE' and node.image:
            low = node.image.name.lower()
            for key, fn in (('basecolor', 'baseColor.png'), ('metallicroughness', 'metallicRoughness.png'), ('normal', 'normal.png')):
                if key in low:
                    cs = node.image.colorspace_settings.name
                    node.image = bpy.data.images.load(TEX_DIR + '/' + fn)
                    node.image.colorspace_settings.name = cs
                    print('TEXTURE', key, '->', fn)
for m in bpy.data.materials:
    m.use_backface_culling = True

bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_extras=True, export_tangents=True, export_yup=True,
                          export_image_format='JPEG', export_jpeg_quality=88, export_animations=False, export_skins=False,
                          export_morph=False, export_cameras=False, export_lights=False)
print('WROTE', OUT)
