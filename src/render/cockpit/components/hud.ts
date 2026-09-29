/**
 * src/render/cockpit/components/hud.ts — a head-up display: the unit, its combiner, and the
 * collimated symbology.
 *
 * The symbology (hudSymbology.ts) is drawn to a canvas in angular space and shown on a quad of
 * DIRECTIONS rendered with the camera's rotation only, i.e. at infinity: like a real HUD's
 * collimated image it stays on the world as the head moves. Each pixel then traces the line of
 * sight from the eye along its direction and is kept only if that line passes through the
 * combiner glass (and inside the total field of view), so the picture is seen through the glass
 * and nowhere else, and moving the head reveals different parts of it (the "porthole" of a real
 * HUD). A blurred mip level adds the phosphor-like glow.
 */

import * as THREE from 'three';
import { Batcher, extrudePolygon, local, mul, type CockpitMaterials } from '../build';
import { createGlassMaterial, type GlassUniforms } from '../glass';
import type { CockpitComponent, CockpitContext } from '../types';
import { HudProjector, drawHud } from './hudSymbology';

export interface HudOptions {
  /** Combiner glass centre (cockpit frame), size (m), and how far its top leans back towards the pilot (rad). */
  combinerCenter: THREE.Vector3;
  combinerW: number;
  combinerH: number;
  combinerLean: number;
  /** Projector body under the combiner: width, height, depth forward (m). */
  bodyW: number;
  bodyH: number;
  bodyDepth: number;
  /** Optical axis elevation (rad, from the design eye) and total field of view (deg, circular). */
  axisElevationRad: number;
  tfovDeg: number;
}

const PICTURE_PX = 1024;

export function createHud(o: HudOptions, mats: CockpitMaterials, batch: Batcher, glassU: GlassUniforms): CockpitComponent & { projector: HudProjector } {
  const object = new THREE.Group();
  const halfTan = Math.tan(((o.tfovDeg / 2 + 1.5) * Math.PI) / 180);
  const projector = new HudProjector(PICTURE_PX, halfTan, o.axisElevationRad);

  // --- Combiner axes: right = +z; up along the glass leans back towards the pilot. ---
  const right = new THREE.Vector3(0, 0, 1);
  const up = new THREE.Vector3(-Math.sin(o.combinerLean), Math.cos(o.combinerLean), 0);
  const normal = new THREE.Vector3(-Math.cos(o.combinerLean), -Math.sin(o.combinerLean), 0);
  // right x up = normal, so this is a proper rotation with the glass facing the pilot.
  const glassFrame = new THREE.Matrix4().makeBasis(right, up, normal);
  glassFrame.setPosition(o.combinerCenter);
  const hw = o.combinerW / 2;
  const hh = o.combinerH / 2;

  // Glass.
  const glassMat = createGlassMaterial(glassU, { tint: 0x9fe0b0, base: 0.035, reflect: 0.55, wear: 0.4 });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(o.combinerW, o.combinerH), glassMat);
  glass.applyMatrix4(glassFrame);
  glass.renderOrder = 5;
  object.add(glass);

  // Frame: side rails, a top bar and the base clamp.
  const rail = 0.009;
  for (const s of [-1, 1]) {
    batch.add(new THREE.BoxGeometry(rail, o.combinerH + 0.012, 0.012), mats.bezel, mul(glassFrame, local(s * (hw + rail / 2), 0, 0)));
  }
  batch.add(new THREE.BoxGeometry(o.combinerW + rail * 2 + 0.004, 0.014, 0.016), mats.bezel, mul(glassFrame, local(0, hh + 0.007, 0)));
  batch.add(new THREE.BoxGeometry(o.combinerW + rail * 2, 0.012, 0.02), mats.bezel, mul(glassFrame, local(0, -hh - 0.004, 0.004)));

  // Side plates with lightening holes, from the body's top up the rails (as on the CSIO unit).
  const baseY = o.combinerCenter.y - hh * Math.cos(o.combinerLean) - 0.01;
  const botX = o.combinerCenter.x + hh * Math.sin(o.combinerLean);
  const topX = o.combinerCenter.x - hh * Math.sin(o.combinerLean);
  const topY = o.combinerCenter.y + hh * Math.cos(o.combinerLean);
  for (const s of [-1, 1]) {
    const shape = new THREE.Shape([
      new THREE.Vector2(botX + 0.045, baseY),
      new THREE.Vector2(botX - 0.012, baseY),
      new THREE.Vector2(topX - 0.012, topY - 0.01),
      new THREE.Vector2(topX + 0.012, topY),
      new THREE.Vector2(botX + 0.02, baseY + 0.05),
    ]);
    const hole = new THREE.Path();
    const hx = (botX + topX) / 2 + 0.006;
    const hy = (baseY + topY) / 2 - 0.02;
    hole.absarc(hx, hy, 0.012, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    const hole2 = new THREE.Path();
    hole2.absarc(botX + 0.012, baseY + 0.022, 0.008, 0, Math.PI * 2, true);
    shape.holes.push(hole2);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.005, bevelEnabled: false });
    batch.add(g, mats.bezel, local(0, 0, s * (hw + rail + 0.0025) - 0.0025));
  }

  // Projector body and the exit lens on top.
  const bodyTop = baseY;
  const bodyFront = botX - 0.02;
  const bodyG = extrudePolygon(
    [
      [0, 0],
      [o.bodyDepth, 0],
      [o.bodyDepth, -o.bodyH],
      [0.02, -o.bodyH],
      [0, -o.bodyH + 0.02],
    ],
    o.bodyW,
    0.002
  );
  // extrudePolygon extrudes along -z; the polygon is in (x forward, y up).
  batch.add(bodyG, mats.bezel, local(bodyFront, bodyTop, o.bodyW / 2));
  const lens = new THREE.Mesh(
    new THREE.PlaneGeometry(o.bodyDepth * 0.55, o.bodyW * 0.7),
    createGlassMaterial(glassU, { tint: 0x203028, base: 0.5, reflect: 1, wear: 0 })
  );
  lens.rotation.x = -Math.PI / 2;
  lens.position.set(bodyFront + o.bodyDepth * 0.4, bodyTop + 0.0015, 0);
  object.add(lens);
  const lensGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(o.bodyDepth * 0.5, o.bodyW * 0.62),
    new THREE.MeshBasicMaterial({ color: 0x0a2a10, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
  );
  lensGlow.rotation.copy(lens.rotation);
  lensGlow.position.set(lens.position.x, bodyTop + 0.001, 0);
  object.add(lensGlow);

  // --- Collimated symbology. ---
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PICTURE_PX;
  const g2d = canvas.getContext('2d')!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  // Quad of directions: optical axis +/- halfTan along right and up.
  const c = new THREE.Vector3(projector.c.x, projector.c.y, projector.c.z);
  const uAx = new THREE.Vector3(projector.u.x, projector.u.y, projector.u.z);
  const quad = new THREE.BufferGeometry();
  const P = (sx: number, sy: number): number[] => {
    const v = c.clone().addScaledVector(right, sx * halfTan).addScaledVector(uAx, sy * halfTan);
    return [v.x, v.y, v.z];
  };
  quad.setAttribute('position', new THREE.Float32BufferAttribute([...P(-1, -1), ...P(1, -1), ...P(1, 1), ...P(-1, -1), ...P(1, 1), ...P(-1, 1)], 3));
  quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  const symMat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uColor: { value: new THREE.Color(0.3, 1.0, 0.42) },
      uEye: glassU.uEye,
      uC: { value: o.combinerCenter.clone() },
      uX: { value: right.clone() },
      uY: { value: up.clone() },
      uN: { value: normal.clone() },
      uHalf: { value: new THREE.Vector2(hw, hh) },
      uRad: { value: 0.012 },
      uAxis: { value: c.clone() },
      uCosFov: { value: Math.cos(((o.tfovDeg / 2) * Math.PI) / 180) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      varying vec2 vUv;
      void main() {
        vDir = position;
        vUv = uv;
        // Rotation only: the picture is at infinity (collimated).
        vec3 v = mat3(viewMatrix) * position;
        gl_Position = projectionMatrix * vec4(v * 4.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform vec3 uColor;
      uniform vec3 uEye;
      uniform vec3 uC;
      uniform vec3 uX;
      uniform vec3 uY;
      uniform vec3 uN;
      uniform vec2 uHalf;
      uniform float uRad;
      uniform vec3 uAxis;
      uniform float uCosFov;
      varying vec3 vDir;
      varying vec2 vUv;
      void main() {
        vec3 d = normalize(vDir);
        float dn = dot(d, uN);
        if (abs(dn) < 1e-4) discard;
        float t = dot(uC - uEye, uN) / dn;
        if (t <= 0.0) discard;
        vec3 h = uEye + d * t - uC;
        vec2 q = vec2(dot(h, uX), dot(h, uY));
        vec2 e = abs(q) - (uHalf - uRad);
        float sd = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0) - uRad;
        float m = 1.0 - smoothstep(-0.0015, 0.0, sd);
        m *= smoothstep(uCosFov - 0.0006, uCosFov + 0.0006, dot(d, uAxis));
        if (m <= 0.0) discard;
        float s = texture2D(uTex, vUv).g;
        float glow = texture2D(uTex, vUv, 2.5).g;
        gl_FragColor = vec4(uColor * (s + glow * 0.85) * m, 1.0);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const symbology = new THREE.Mesh(quad, symMat);
  symbology.frustumCulled = false;
  symbology.userData.noPick = true;
  symbology.raycast = () => {};
  symbology.renderOrder = 10;
  object.add(symbology);

  let lastDraw = -1;
  const col = symMat.uniforms.uColor!.value as THREE.Color;

  return {
    object,
    projector,
    update(ctx: CockpitContext) {
      // The symbol generator runs at the display rate (capped at ~60 Hz).
      if (ctx.timeSec - lastDraw >= 1 / 62 || lastDraw < 0) {
        lastDraw = ctx.timeSec;
        drawHud(g2d, projector, ctx, { inv: ctx.inv, gunRounds: ctx.gunRounds });
        tex.needsUpdate = true;
      }
      // Auto brightness: bright against a sunlit sky, dim at night; the pilot's knob scales it.
      const amb = ctx.f.ambSky;
      const day = Math.min(1, (amb.r + amb.g + amb.b) / 1.2 + (ctx.f.sunCol.r + ctx.f.sunCol.g) * 0.4);
      const k = ctx.local.hudBrightness * (0.28 + 0.95 * day);
      col.setRGB(0.3 * k, 1.0 * k, 0.42 * k);
      (lensGlow.material as THREE.MeshBasicMaterial).color.setRGB(0.02 * k, 0.09 * k, 0.03 * k);
    },
    dispose() {
      tex.dispose();
      symMat.dispose();
      glassMat.dispose();
      quad.dispose();
    },
  };
}
