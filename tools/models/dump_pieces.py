# Blender (headless): import a source glTF, split every mesh into loose pieces, and dump each piece
# (vertices in the sim's body axes: x forward, y up, z right; triangles) to JSON for classification.
# Usage: blender -b --factory-startup --python dump_pieces.py -- <scene.gltf> <out.json>
import bpy, bmesh, sys, json
args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[0], args[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
pieces = []
for o in list(bpy.data.objects):
    if o.type != 'MESH':
        continue
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.transform(o.matrix_world)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    # Connected components over faces sharing a vertex position (UV seams split verts, so weld by position).
    key = {}
    rep = []
    for v in bm.verts:
        k = tuple(round(c, 4) for c in v.co)
        rep.append(key.setdefault(k, len(key)))
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
    for faces in comps.values():
        vmap = {}
        pos = []
        tris = []
        for fi in faces:
            t = []
            for v in bm.faces[fi].verts:
                if v.index not in vmap:
                    vmap[v.index] = len(pos)
                    X, Y, Z = v.co
                    pos.append([round(-Y, 4), round(Z, 4), round(-X, 4)])  # body axes, origin not yet set
                t.append(vmap[v.index])
            tris.append(t)
        pieces.append({'mesh': o.name, 'faces': faces, 'pos': pos, 'tris': tris})
    bm.free()
json.dump({'pieces': pieces}, open(out, 'w'))
print('PIECES', len(pieces))
