/**
 * src/briefing/room.ts — the operations room round the map table: dark walls and floor, the table,
 * faceless low-poly officers standing round it and leaning over it (backlit silhouettes), wall
 * screens showing generic radar, scrolling unreadable text and charts (procedural, drawn in code),
 * lamps over the table with haze in their beams and dust drifting through them.
 *
 * Kept light for a slow PC: one point light (the table's glow), one rim light (the screens), no
 * shadows, a few dozen draw calls, screens redrawn a few times a second at most.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TABLE_MAP_SIZE_M, TABLE_TOP_Y } from './mapData';

export interface Room {
  group: THREE.Group;
  update(t: number, dt: number): void;
  dispose(): void;
}

/** A small deterministic random (the room is the same every time). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Pose = 'lean' | 'stand' | 'crossed' | 'point' | 'behind';

/**
 * One officer, ~1.75 m, facing +z (towards the table once placed): legs, a torso leaning from the
 * hips, a head, maybe a peaked cap, arms posed. No face, no detail: a silhouette.
 */
function officerGeometry(pose: Pose, cap: boolean, build: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const add = (g: THREE.BufferGeometry, mat: THREE.Matrix4): void => {
    g.applyMatrix4(mat);
    // Positions and normals only (the material needs no uv), so every part merges.
    g.deleteAttribute('uv');
    parts.push(g);
  };
  const hipY = 0.9;
  // Legs.
  for (const sx of [-1, 1]) add(new THREE.CylinderGeometry(0.075, 0.06, hipY, 6), m.makeTranslation(sx * 0.1 * build, hipY / 2, 0));
  const lean = pose === 'lean' ? 0.62 : pose === 'point' ? 0.35 : 0.05;
  // Upper body in a frame at the hips, tipped forward by `lean`.
  const upper = new THREE.Matrix4().makeTranslation(0, hipY, 0).multiply(new THREE.Matrix4().makeRotationX(lean));
  const torso = new THREE.CylinderGeometry(0.21 * build, 0.16 * build, 0.6, 7);
  torso.scale(1, 1, 0.62);
  add(torso, upper.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.3, 0)));
  add(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 6), upper.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.64, 0)));
  const headM = upper.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.77, 0.01));
  const head = new THREE.SphereGeometry(0.105, 9, 7);
  head.scale(0.92, 1.08, 1);
  add(head, headM.clone());
  if (cap) {
    add(new THREE.CylinderGeometry(0.118, 0.108, 0.07, 9), headM.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.09, 0)));
    const brim = new THREE.CylinderGeometry(0.1, 0.1, 0.012, 9, 1, false, -Math.PI / 2, Math.PI);
    add(brim, headM.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.065, 0.06)));
  }
  // Arms: from each shoulder to a hand, as a tapered cylinder (upper frame).
  const arm = (side: number, hand: THREE.Vector3): void => {
    const sh = new THREE.Vector3(side * 0.24 * build, 0.54, 0);
    const d = new THREE.Vector3().subVectors(hand, sh);
    const len = d.length();
    const g = new THREE.CylinderGeometry(0.045, 0.038, len, 5);
    g.translate(0, -len / 2, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), d.normalize());
    add(g, upper.clone().multiply(new THREE.Matrix4().compose(sh, q, new THREE.Vector3(1, 1, 1))));
  };
  switch (pose) {
    case 'lean':
      // Hands flat on the table edge in front.
      arm(-1, new THREE.Vector3(-0.3, -0.05, 0.42));
      arm(1, new THREE.Vector3(0.3, -0.05, 0.42));
      break;
    case 'point':
      arm(-1, new THREE.Vector3(-0.27, -0.02, 0.18));
      arm(1, new THREE.Vector3(0.12, 0.18, 0.72));
      break;
    case 'crossed':
      arm(-1, new THREE.Vector3(0.12, 0.3, 0.2));
      arm(1, new THREE.Vector3(-0.12, 0.32, 0.2));
      break;
    case 'behind':
      arm(-1, new THREE.Vector3(-0.05, 0.02, -0.16));
      arm(1, new THREE.Vector3(0.05, 0.02, -0.16));
      break;
    default:
      arm(-1, new THREE.Vector3(-0.3, -0.02, 0.02));
      arm(1, new THREE.Vector3(0.3, -0.02, 0.02));
  }
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return g;
}

/** Wall screens: canvas textures drawn in code (nothing readable on them). */
function makeScreens(): { meshes: THREE.Mesh[]; update(t: number): void; dispose(): void } {
  const meshes: THREE.Mesh[] = [];
  const updaters: ((t: number) => void)[] = [];
  const disposables: { dispose(): void }[] = [];
  const hasDom = typeof document !== 'undefined';
  const canvasTex = (w: number, h: number): { c: HTMLCanvasElement | null; g: CanvasRenderingContext2D | null; tex: THREE.Texture } => {
    if (!hasDom) return { c: null, g: null, tex: new THREE.Texture() };
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    disposables.push(tex);
    return { c, g: c.getContext('2d'), tex };
  };
  const rand = rng(77);

  // 1. Radar: a sweep in a shader (smooth, no redraws), range rings, a few fading returns.
  const radarMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
      void main(){
        vec2 p = (vUv - 0.5) * vec2(1.6, 1.0) * 2.0;
        float r = length(p);
        vec3 bg = vec3(0.01, 0.035, 0.03);
        if (r > 0.96) { gl_FragColor = vec4(bg * 0.6, 1.0); return; }
        float a = atan(p.y, p.x);
        float sweep = mod(uTime * 1.1, 6.2831853);
        float d = mod(sweep - a + 6.2831853, 6.2831853);
        float trail = exp(-d * 2.4);
        float rings = smoothstep(0.012, 0.0, abs(fract(r * 4.0) - 0.5) - 0.48);
        float spokes = smoothstep(0.01, 0.0, abs(p.x)) + smoothstep(0.01, 0.0, abs(p.y));
        vec2 cell = floor(p * 9.0);
        float blip = step(0.965, h(cell)) * smoothstep(0.25, 0.0, length(fract(p * 9.0) - 0.5)) * exp(-d * 0.9);
        vec3 g = vec3(0.25, 1.0, 0.7);
        vec3 col = bg + g * (trail * 0.45 + rings * 0.18 + spokes * 0.08 + blip * 1.2);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  disposables.push(radarMat);
  updaters.push((t) => (radarMat.uniforms.uTime!.value = t));

  // 2. Scrolling text: blocks of "words" (rectangles of varied width): reads as text, says nothing.
  const text = canvasTex(256, 512);
  if (text.g) {
    const g = text.g;
    g.fillStyle = '#05100f';
    g.fillRect(0, 0, 256, 512);
    for (let y = 6; y < 512; y += 11) {
      let x = 8;
      const bright = rand() < 0.1;
      g.fillStyle = bright ? 'rgba(255, 196, 90, 0.85)' : 'rgba(120, 220, 200, 0.55)';
      const end = 60 + rand() * 180;
      while (x < end) {
        const w = 6 + rand() * 26;
        g.fillRect(x, y, w, 4);
        x += w + 4;
      }
    }
    text.tex.wrapT = THREE.RepeatWrapping;
    text.tex.repeat.set(1, 0.45);
  }
  updaters.push((t) => (text.tex.offset.y = -((t * 0.035) % 1)));

  // 3. Charts: bars and a trace, redrawn a few times a second with a moving cursor.
  const chart = canvasTex(256, 160);
  let lastChart = -1;
  const series = Array.from({ length: 12 }, () => 0.2 + rand() * 0.7);
  updaters.push((t) => {
    const g = chart.g;
    if (!g) return;
    const step = Math.floor(t * 3);
    if (step === lastChart) return;
    lastChart = step;
    g.fillStyle = '#06100f';
    g.fillRect(0, 0, 256, 160);
    g.strokeStyle = 'rgba(120, 200, 190, 0.18)';
    g.lineWidth = 1;
    for (let y = 20; y < 160; y += 28) {
      g.beginPath();
      g.moveTo(10, y);
      g.lineTo(246, y);
      g.stroke();
    }
    for (let i = 0; i < series.length; i++) {
      series[i] = Math.min(0.95, Math.max(0.08, series[i]! + (Math.sin(step * 0.7 + i * 1.3) * 0.04)));
      g.fillStyle = i === step % series.length ? 'rgba(255, 190, 80, 0.9)' : 'rgba(90, 200, 180, 0.7)';
      const h = series[i]! * 80;
      g.fillRect(14 + i * 19, 150 - h, 12, h);
    }
    g.strokeStyle = 'rgba(255, 120, 90, 0.85)';
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= 236; x += 4) {
      const y = 38 + Math.sin((x + step * 8) * 0.045) * 14 + Math.sin((x + step * 3) * 0.13) * 5;
      if (x === 0) g.moveTo(10 + x, y);
      else g.lineTo(10 + x, y);
    }
    g.stroke();
    chart.tex.needsUpdate = true;
  });

  // 4. A plot of tracks: a faint grid with crawling dots (redrawn slowly).
  const plot = canvasTex(256, 144);
  let lastPlot = -1;
  const tracks = Array.from({ length: 9 }, () => ({ x: rand() * 256, y: rand() * 144, vx: (rand() - 0.5) * 6, vy: (rand() - 0.5) * 4, hostile: rand() < 0.4 }));
  updaters.push((t) => {
    const g = plot.g;
    if (!g) return;
    const step = Math.floor(t * 2);
    if (step === lastPlot) return;
    lastPlot = step;
    g.fillStyle = '#050c12';
    g.fillRect(0, 0, 256, 144);
    g.strokeStyle = 'rgba(110, 170, 220, 0.16)';
    for (let x = 0; x < 256; x += 32) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, 144);
      g.stroke();
    }
    for (let y = 0; y < 144; y += 32) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(256, y);
      g.stroke();
    }
    for (const k of tracks) {
      const x = (((k.x + k.vx * step) % 256) + 256) % 256, y = (((k.y + k.vy * step) % 144) + 144) % 144;
      g.fillStyle = k.hostile ? 'rgba(255, 90, 70, 0.9)' : 'rgba(120, 210, 255, 0.9)';
      g.fillRect(x - 3, y - 3, 6, 6);
      g.fillRect(x + 5, y - 1, 10, 2);
    }
    plot.tex.needsUpdate = true;
  });

  const screen = (mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry: number): void => {
    const bezel = new THREE.Mesh(new THREE.PlaneGeometry(w + 0.08, h + 0.08), new THREE.MeshBasicMaterial({ color: 0x07090b }));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.position.z = 0.004;
    const root = new THREE.Group();
    root.add(bezel, m);
    root.position.set(x, y, z);
    root.rotation.y = ry;
    meshes.push(root as unknown as THREE.Mesh);
  };
  const basic = (tex: THREE.Texture): THREE.MeshBasicMaterial => {
    const m = new THREE.MeshBasicMaterial({ map: tex, color: 0xb8c4c4 });
    disposables.push(m);
    return m;
  };
  // The north wall: radar in the middle, text and charts each side; plots on the side walls.
  screen(radarMat, 1.7, 1.0, 0, 1.75, -4.46, 0);
  screen(basic(text.tex), 0.9, 1.0, -1.65, 1.75, -4.46, 0);
  screen(basic(chart.tex), 1.2, 0.7, 1.75, 2.0, -4.46, 0);
  screen(basic(plot.tex), 1.2, 0.62, 1.75, 1.28, -4.46, 0);
  screen(basic(plot.tex), 1.5, 0.85, -4.96, 2.0, -1.2, Math.PI / 2);
  screen(basic(chart.tex), 1.2, 0.7, 4.96, 2.0, -1.6, -Math.PI / 2);
  for (const u of updaters) u(0);
  return {
    meshes,
    update(t) {
      for (const u of updaters) u(t);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** A soft round spot (dust, haze) as a small canvas texture. */
function softSprite(): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture();
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function createRoom(): Room {
  const group = new THREE.Group();
  group.name = 'ops-room';
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // Light: the table's glow (cool, from just above the map), the screens' rim from the north wall,
  // and a faint warm fill from the lamps.
  const glow = new THREE.PointLight(0xa8cde0, 7, 7, 1.6);
  glow.position.set(0, TABLE_TOP_Y + 0.55, 0);
  const rim = new THREE.DirectionalLight(0x6fb0c8, 1.6);
  rim.position.set(0.3, 2.2, -4);
  const fill = new THREE.HemisphereLight(0x2a2620, 0x050607, 0.12);
  group.add(glow, rim, fill);

  // Walls and floor: dark, matte.
  const wallMat = track(new THREE.MeshLambertMaterial({ color: 0x15181b }));
  const floorMat = track(new THREE.MeshLambertMaterial({ color: 0x0f1113 }));
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(10, 10)), floorMat);
  floor.rotation.x = -Math.PI / 2;
  const back = new THREE.Mesh(track(new THREE.PlaneGeometry(10, 3.6)), wallMat);
  back.position.set(0, 1.8, -4.5);
  const left = new THREE.Mesh(track(new THREE.PlaneGeometry(10, 3.6)), wallMat);
  left.position.set(-5, 1.8, 0);
  left.rotation.y = Math.PI / 2;
  const right = left.clone();
  right.position.x = 5;
  right.rotation.y = -Math.PI / 2;
  const front = new THREE.Mesh(track(new THREE.PlaneGeometry(10, 3.6)), wallMat);
  front.position.set(0, 1.8, 5);
  front.rotation.y = Math.PI;
  const ceil = new THREE.Mesh(track(new THREE.PlaneGeometry(10, 10)), track(new THREE.MeshBasicMaterial({ color: 0x050607 })));
  ceil.position.y = 3.6;
  ceil.rotation.x = Math.PI / 2;
  group.add(floor, back, left, right, front, ceil);

  // The table: a dark slab, a lit edge round the map.
  const S = TABLE_MAP_SIZE_M + 0.34;
  const slab = new THREE.Mesh(track(new THREE.BoxGeometry(S, TABLE_TOP_Y, S)), track(new THREE.MeshLambertMaterial({ color: 0x101316 })));
  slab.position.y = TABLE_TOP_Y / 2;
  const top = new THREE.Mesh(track(new THREE.PlaneGeometry(S, S)), track(new THREE.MeshBasicMaterial({ color: 0x0b1215 })));
  top.rotation.x = -Math.PI / 2;
  top.position.y = TABLE_TOP_Y + 0.001;
  const edgeMat = track(new THREE.MeshBasicMaterial({ color: 0x4fb4cf, transparent: true, opacity: 0.55 }));
  const edges = new THREE.Group();
  const E = TABLE_MAP_SIZE_M + 0.06;
  for (let q = 0; q < 4; q++) {
    const bar = new THREE.Mesh(track(new THREE.PlaneGeometry(E, 0.006)), edgeMat);
    bar.rotation.x = -Math.PI / 2;
    bar.rotation.z = (q * Math.PI) / 2;
    const d = E / 2;
    bar.position.set(q === 1 ? d : q === 3 ? -d : 0, TABLE_TOP_Y + 0.002, q === 0 ? d : q === 2 ? -d : 0);
    edges.add(bar);
  }
  // A thin glowing line round the slab's lip, seen from the side.
  const lip = new THREE.Mesh(track(new THREE.BoxGeometry(S + 0.004, 0.012, S + 0.004)), track(new THREE.MeshBasicMaterial({ color: 0x2c6f80 })));
  lip.position.y = TABLE_TOP_Y - 0.02;
  group.add(slab, top, edges, lip);

  // The officers.
  const figMat = track(new THREE.MeshLambertMaterial({ color: 0x0e1012 }));
  const rand = rng(1947);
  const half = S / 2;
  const spots: { x: number; z: number; pose: Pose; cap: boolean }[] = [
    { x: -0.55, z: half + 0.36, pose: 'lean', cap: true },
    { x: 0.75, z: half + 0.42, pose: 'crossed', cap: false },
    { x: -half - 0.4, z: -0.3, pose: 'lean', cap: false },
    { x: -half - 0.55, z: 0.75, pose: 'stand', cap: true },
    { x: half + 0.36, z: 0.55, pose: 'point', cap: true },
    { x: half + 0.5, z: -0.6, pose: 'behind', cap: false },
    { x: -0.4, z: -half - 0.4, pose: 'lean', cap: true },
    { x: 0.45, z: -half - 0.5, pose: 'stand', cap: false },
    { x: 1.2, z: -half - 0.62, pose: 'crossed', cap: true },
  ];
  const figures: { mesh: THREE.Mesh; phase: number; baseRot: number }[] = [];
  for (const s of spots) {
    const g = track(officerGeometry(s.pose, s.cap, 0.92 + rand() * 0.16));
    const mesh = new THREE.Mesh(g, figMat);
    mesh.position.set(s.x, 0, s.z);
    // Face the table (+z of the model towards its middle), a little off-square.
    const yaw = Math.atan2(-s.x, -s.z) + (rand() - 0.5) * 0.35;
    mesh.rotation.y = yaw;
    mesh.name = 'officer';
    group.add(mesh);
    figures.push({ mesh, phase: rand() * 6.28, baseRot: yaw });
  }

  // Lamps over the table, with haze in their beams.
  const beamTex = (() => {
    if (typeof document === 'undefined') return new THREE.Texture();
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, 'rgba(255,255,255,0.0)');
    grad.addColorStop(0.08, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0.0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(c);
  })();
  track(beamTex);
  const beamMat = track(new THREE.MeshBasicMaterial({ map: beamTex, color: 0x6f7f86, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const lampMat = track(new THREE.MeshBasicMaterial({ color: 0xcfd8dc }));
  for (const [x, z] of [[-0.75, -0.6], [0.75, -0.6], [-0.75, 0.65], [0.75, 0.65]] as const) {
    const lamp = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 16)), lampMat);
    lamp.position.set(x, 3.5, z);
    const h = 3.5 - TABLE_TOP_Y;
    const cone = new THREE.Mesh(track(new THREE.CylinderGeometry(0.15, 0.75, h, 18, 1, true)), beamMat);
    cone.position.set(x, TABLE_TOP_Y + h / 2, z);
    cone.renderOrder = 30;
    group.add(lamp, cone);
  }

  // Dust in the light.
  const N = 360;
  const dustPos = new Float32Array(N * 3);
  const dustSeed = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    dustSeed[i * 3] = (rand() - 0.5) * 2.6;
    dustSeed[i * 3 + 1] = TABLE_TOP_Y + 0.2 + rand() * 2.4;
    dustSeed[i * 3 + 2] = (rand() - 0.5) * 2.6;
  }
  const dustGeo = track(new THREE.BufferGeometry());
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, track(new THREE.PointsMaterial({ size: 0.014, map: track(softSprite()), color: 0x9fb2ba, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending })));
  dust.renderOrder = 31;
  group.add(dust);

  const screens = makeScreens();
  for (const m of screens.meshes) group.add(m);

  return {
    group,
    update(t) {
      screens.update(t);
      // Glow breathes a little, as a projector table does.
      glow.intensity = 7 * (0.94 + 0.06 * Math.sin(t * 0.7));
      for (const f of figures) {
        f.mesh.rotation.y = f.baseRot + Math.sin(t * 0.35 + f.phase) * 0.025;
        f.mesh.position.y = Math.sin(t * 0.9 + f.phase) * 0.003;
      }
      for (let i = 0; i < N; i++) {
        const sx = dustSeed[i * 3]!, sy = dustSeed[i * 3 + 1]!, sz = dustSeed[i * 3 + 2]!;
        dustPos[i * 3] = sx + Math.sin(t * 0.11 + i) * 0.12;
        dustPos[i * 3 + 1] = TABLE_TOP_Y + 0.2 + ((sy - TABLE_TOP_Y - 0.2 + t * 0.012 * (1 + (i % 5) * 0.2)) % 2.4);
        dustPos[i * 3 + 2] = sz + Math.cos(t * 0.09 + i * 1.7) * 0.12;
      }
      dustGeo.attributes.position!.needsUpdate = true;
    },
    dispose() {
      screens.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
