# Blender: import the source glTF and print object world transforms/bounds (orientation probe).
import bpy, sys, mathutils
src = sys.argv[sys.argv.index('--') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    ws = [o.matrix_world @ v.co for v in o.data.vertices]
    mn = [min(v[i] for v in ws) for i in range(3)]; mx = [max(v[i] for v in ws) for i in range(3)]
    print('OBJ', o.name, 'verts', len(ws), 'min', [round(c,3) for c in mn], 'max', [round(c,3) for c in mx])
    # nose = extreme along which axis? print the vertex with max |coord| on each axis
    for i,a in enumerate('XYZ'):
        lo = min(ws, key=lambda v: v[i]); hi = max(ws, key=lambda v: v[i])
        print('  ', a, 'lo', [round(c,2) for c in lo], 'hi', [round(c,2) for c in hi])
