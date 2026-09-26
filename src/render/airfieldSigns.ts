/**
 * src/render/airfieldSigns.ts — taxiway and runway signs (src/airport/airfieldAids.ts): a panel on
 * two short legs, its face drawn from a texture atlas made once from every sign's text on a canvas
 * (red with white text for holding-point signs, yellow with black text and arrows for direction
 * signs, black with a white number for runway distance-remaining boards). One instanced mesh; lit
 * like the ground by day and lit from within at night.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';

export interface SignList {
  groundY: number;
  signs: readonly { x: number; z: number; headingRad: number; text: string; style: 'mandatory' | 'direction' | 'distance' }[];
}

const CELL_W = 512;
const CELL_H = 96;
const ATLAS_W = 2048;

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aFace; // 1 = the sign's face, 0 = frame/back/legs
  attribute vec4 iUv;    // atlas rectangle of this sign's face
  varying vec2 vUv;
  varying float vFace;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vFace = aFace;
    vUv = mix(iUv.xy, iUv.zw, uv);
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vNormalW = normalize(mat3(instanceMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(atmCurve(wp.xyz), 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  varying float vFace;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vec3 col = vFace > 0.5 ? texture2D(uAtlas, vUv).rgb : vec3(0.12, 0.12, 0.13);
    vec3 n = normalize(vNormalW);
    vec3 L = normalize(uAtmSunDir);
    vec3 lit = col * (mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y) + uAtmSunCol * max(dot(n, L), 0.0));
    // Signs are lit from within at night.
    lit += col * vFace * 0.55 * uAtmLights;
    gl_FragColor = vec4(atmApply(lit, vWorld), 1.0);
  }
`;

/** A sign panel on two legs, unit size: x -0.5..0.5, y 0..1 (panel from 0.35), face on -z. */
function signGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const face: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], isFace: number, uv?: number[][]): void => {
    for (const [p, t] of [[a, 0], [b, 1], [c, 2], [a, 0], [c, 2], [d, 3]] as [number[], number][]) {
      pos.push(...p);
      nor.push(...n);
      uvs.push(...(uv ? uv[t]! : [0, 0]));
      face.push(isFace);
    }
  };
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, faceFront: boolean): void => {
    // Front (-z): the face, uv (0,0) bottom-left seen from the front.
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], faceFront ? 1 : 0, faceFront ? [[0, 1], [1, 1], [1, 0], [0, 0]] : undefined);
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0);
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], 0);
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], 0);
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0], 0);
  };
  box(-0.5, 0.5, 0.35, 1, -0.5, 0.5, true);
  box(-0.38, -0.3, 0, 0.35, -0.2, 0.2, false);
  box(0.3, 0.38, 0, 0.35, -0.2, 0.2, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 1));
  return g;
}

export interface AirfieldSigns {
  setSigns(lists: readonly SignList[]): void;
  updateOrigin(originWorld: Readonly<Vec3Like>): void;
  dispose(): void;
}

export function createAirfieldSigns(root: THREE.Object3D): AirfieldSigns {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  root.add(group);
  const geom = signGeometry();
  let mesh: THREE.InstancedMesh | undefined;
  let atlas: THREE.CanvasTexture | undefined;
  const mat = new THREE.ShaderMaterial({ uniforms: { ...getAtmosphereUniforms(), uAtlas: { value: null } }, vertexShader: VS, fragmentShader: FS });

  return {
    setSigns(lists) {
      if (mesh) {
        group.remove(mesh);
        mesh.dispose();
        mesh = undefined;
      }
      atlas?.dispose();
      atlas = undefined;
      const all = lists.flatMap((l) => l.signs.map((s) => ({ ...s, y: l.groundY })));
      if (all.length === 0 || typeof document === 'undefined') return;
      // One atlas cell per distinct (style, text).
      const keyOf = (s: { style: string; text: string }): string => `${s.style}|${s.text}`;
      const cells = [...new Set(all.map(keyOf))];
      const perRow = ATLAS_W / CELL_W;
      const rows = Math.ceil(cells.length / perRow);
      let h = 1;
      while (h < rows * CELL_H) h *= 2;
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS_W;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      const cellIndex = new Map<string, number>();
      cells.forEach((k, i) => {
        cellIndex.set(k, i);
        const [style, text] = k.split('|') as [string, string];
        const x = (i % perRow) * CELL_W;
        const y = Math.floor(i / perRow) * CELL_H;
        const bg = style === 'mandatory' ? '#b3121a' : style === 'direction' ? '#f0c419' : '#141414';
        const fg = style === 'direction' ? '#111111' : '#f4f4f4';
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, CELL_W, CELL_H);
        ctx.fillStyle = fg;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Tokens: runway ids and arrows (drawn as shapes), laid out left to right.
        const parts: { kind: 'text' | 'arrow'; s: string }[] = [];
        for (const tok of text.split(' ')) {
          const m = /^([<^]?)([^<>^]+)(>?)$/.exec(tok);
          if (!m) {
            parts.push({ kind: 'text', s: tok });
            continue;
          }
          if (m[1]) parts.push({ kind: 'arrow', s: m[1] });
          parts.push({ kind: 'text', s: m[2]! });
          if (m[3]) parts.push({ kind: 'arrow', s: m[3] });
        }
        let size = 70;
        const ARROW_W = 0.8;
        const gap = 0.35;
        const widthAt = (sz: number): number => {
          ctx.font = `bold ${sz}px sans-serif`;
          return parts.reduce((w, p) => w + (p.kind === 'arrow' ? sz * ARROW_W : ctx.measureText(p.s).width) + sz * gap, -sz * gap);
        };
        while (widthAt(size) > CELL_W * 0.9 && size > 20) size -= 4;
        ctx.font = `bold ${size}px sans-serif`;
        let cx = x + (CELL_W - widthAt(size)) / 2;
        const cy = y + CELL_H / 2;
        ctx.textAlign = 'left';
        for (const p of parts) {
          if (p.kind === 'text') {
            ctx.fillText(p.s, cx, cy + 4);
            cx += ctx.measureText(p.s).width;
          } else {
            const w = size * ARROW_W;
            const hh = size * 0.34;
            ctx.save();
            ctx.translate(cx + w / 2, cy);
            ctx.rotate(p.s === '<' ? Math.PI : p.s === '^' ? -Math.PI / 2 : 0);
            ctx.beginPath();
            ctx.moveTo(-w / 2, -hh * 0.35);
            ctx.lineTo(w * 0.1, -hh * 0.35);
            ctx.lineTo(w * 0.1, -hh);
            ctx.lineTo(w / 2, 0);
            ctx.lineTo(w * 0.1, hh);
            ctx.lineTo(w * 0.1, hh * 0.35);
            ctx.lineTo(-w / 2, hh * 0.35);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
            cx += w;
          }
          cx += size * gap;
        }
        if (style === 'mandatory') {
          ctx.strokeStyle = '#f4f4f4';
          ctx.lineWidth = 4;
          ctx.strokeRect(x + 6, y + 6, CELL_W - 12, CELL_H - 12);
        }
      });
      atlas = new THREE.CanvasTexture(canvas);
      atlas.colorSpace = THREE.NoColorSpace;
      atlas.anisotropy = 4;
      mat.uniforms['uAtlas']!.value = atlas;

      mesh = new THREE.InstancedMesh(geom, mat, all.length);
      const uvAttr = new Float32Array(all.length * 4);
      const m = new THREE.Matrix4();
      all.forEach((s, i) => {
        const ci = cellIndex.get(keyOf(s))!;
        const u0 = ((ci % perRow) * CELL_W) / ATLAS_W;
        const v0 = 1 - ((Math.floor(ci / perRow) + 1) * CELL_H) / h;
        uvAttr.set([u0, v0 + CELL_H / h, u0 + CELL_W / ATLAS_W, v0], i * 4);
        const width = s.style === 'distance' ? 1.6 : Math.max(2.2, s.text.length * 0.55 + 0.9);
        const height = s.style === 'distance' ? 2.2 : 1.6;
        const c = Math.cos(s.headingRad);
        const sn = Math.sin(s.headingRad);
        const depth = 0.3;
        m.set(c * width, 0, -sn * depth, s.x, 0, height, 0, s.y, sn * width, 0, c * depth, s.z, 0, 0, 0, 1);
        mesh!.setMatrixAt(i, m);
      });
      geom.setAttribute('iUv', new THREE.InstancedBufferAttribute(uvAttr, 4));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      group.add(mesh);
    },
    updateOrigin(origin) {
      group.position.set(-origin.x, -origin.y, -origin.z);
      group.updateMatrix();
      group.updateMatrixWorld(true);
    },
    dispose() {
      if (mesh) mesh.dispose();
      geom.dispose();
      atlas?.dispose();
      mat.dispose();
      root.remove(group);
    },
  };
}
