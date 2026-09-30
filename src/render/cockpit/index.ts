/**
 * src/render/cockpit/index.ts — the 3D cockpit: scene, lighting, head, avionics, interaction.
 *
 * SceneRenderer draws the world from the pilot's eye, then this cockpit over it in its own pass
 * (depth cleared, near plane 2 cm) before anti-aliasing and grading, so both are graded alike and
 * the cockpit never z-fights the world. The cockpit scene is authored in the cockpit frame (body
 * axes, origin at the design eye point); the sun and sky are turned into that frame every frame,
 * so shadows of the canopy frame sweep across the panel as the aircraft manoeuvres.
 *
 * Aircraft-specific arrangement lives in a CockpitLayout (layouts/); everything else is generic.
 */

import * as THREE from 'three';
import { EntityFlag, SpeedUnit } from '../../contracts/core';
import type { CockpitAction, CockpitAuxState, CockpitHover, CockpitPilotControls } from '../../contracts/render';
import { createAvionics, createAvionicsState, createStoreInventory, storeInventory, toBody, updateAvionics } from './avionics';
import { Batcher, PanelAtlas, createMaterials, type CockpitMaterials } from './build';
import { createGlassUniforms, type GlassUniforms } from './glass';
import { createHeadState, lookHead, recenterHead, updateHead, type HeadState } from './head';
import type { CockpitComponent, CockpitContext, CockpitControl, CockpitFlight, CockpitLocalState } from './types';

/** What a layout gets to build with. */
export interface CockpitKit {
  mats: CockpitMaterials;
  atlas: PanelAtlas;
  batch: Batcher;
  glassU: GlassUniforms;
  root: THREE.Group;
}

export interface CockpitLayout {
  name: string;
  /** Design eye point in the aircraft body frame, m. */
  eyeBody: THREE.Vector3;
  /** Initial display pages by MFD id. */
  mfdPages: Record<string, string>;
  build(kit: CockpitKit): CockpitComponent[];
}

export interface CockpitSystem {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Advances the head (look, G, buffet) and returns the eye in the BODY frame and the camera
   * orientation relative to the body. Call once per frame before `update`.
   */
  head(dtSec: number): { eyeBody: THREE.Vector3; rotBody: THREE.Quaternion; fovDeg: number };
  /** Updates avionics, displays and moving parts, and places the cockpit camera. */
  update(flight: CockpitFlight, dtSec: number, timeSec: number, aspect: number): void;
  look(dYaw: number, dPitch: number, dFov: number): void;
  recenter(): void;
  setControls(c: Readonly<CockpitPilotControls>): void;
  setAux(a: Readonly<CockpitAuxState>): void;
  /** Pointer at normalised device coords (null = none): hover and click. */
  pointer(ndcX: number | null, ndcY: number, click: boolean, cssX: number, cssY: number): { action: CockpitAction | null; hover: CockpitHover | null };
  /** Shadow map on/off and size by quality tier. */
  setShadowQuality(size: number): void;
  dispose(): void;
}

const toLinear = (c: { r: number; g: number; b: number }, out: THREE.Color, k = 1): THREE.Color =>
  out.setRGB(Math.pow(Math.max(0, c.r), 2.2) * k, Math.pow(Math.max(0, c.g), 2.2) * k, Math.pow(Math.max(0, c.b), 2.2) * k);

export function createCockpitSystem(layout: CockpitLayout): CockpitSystem {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, 1, 0.02, 30);
  const root = new THREE.Group();
  scene.add(root);

  const atlas = new PanelAtlas();
  const mats = createMaterials(atlas);
  const batch = new Batcher();
  const glassU = createGlassUniforms();

  // Lights: the sun (with a tight shadow map round the cockpit), sky/ground ambient, a soft fill
  // from the canopy (light scattered in by the glass and bounced off the panels), and the night
  // flood lights.
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera;
  sc.left = -1.35;
  sc.right = 1.35;
  sc.top = 1.35;
  sc.bottom = -1.35;
  sc.near = 0.1;
  sc.far = 8;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.012;
  sun.shadow.radius = 2;
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);
  // Light scattered in through the canopy and bounced round the cockpit: a soft, even fill.
  const fill = new THREE.AmbientLight(0xffffff, 1);
  scene.add(fill);
  const flood = new THREE.PointLight(0xffe6c0, 0, 1.6, 1.5);
  flood.position.set(0.25, 0.05, 0);
  scene.add(flood);

  const components = layout.build({ mats, atlas, batch, glassU, root });
  // Dev aid for profiling: ?pitoff=shadow,glass,hud,update,canvas,all turns parts off (canvas:
  // screen.ts; all: the whole cockpit, keeping the pilot's-eye camera).
  const off = new Set(typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('pitoff') ?? '').split(',') : []);
  for (const c of components) root.add(c.object);
  batch.flush(root);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m.material as THREE.Material).transparent) {
      m.receiveShadow = true;
      if (m.castShadow === undefined || m.castShadow === false) m.castShadow = true;
    }
  });
  const controls: CockpitControl[] = components.flatMap((c) => c.controls ?? []);
  if (off.has('shadow')) sun.castShadow = false;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.Material;
    if (off.has('glass') && mat instanceof THREE.ShaderMaterial && mat.transparent && mat.blending === THREE.CustomBlending) m.visible = false;
    if (off.has('hud') && mat instanceof THREE.ShaderMaterial && mat.blending === THREE.AdditiveBlending) m.visible = false;
  });

  const head: HeadState = createHeadState();
  const eye = new THREE.Vector3();
  const eyeBody = new THREE.Vector3();
  const rotBody = new THREE.Quaternion();
  let fovDeg = 62;

  const av = createAvionics();
  const avState = createAvionicsState();
  const inv = createStoreInventory();
  const pilot: CockpitPilotControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, trigger: false };
  const aux: CockpitAuxState = { masterArm: true, lightMode: '', speedUnit: SpeedUnit.Knots };
  const local: CockpitLocalState = {
    mfdPage: { ...layout.mfdPages },
    hudDeclutter: 0,
    hudBrightness: 1,
    radarRangeKm: 40,
    hsiRangeKm: 80,
    panelLights: 0.7,
    floodLights: 0.5,
    ufcpField: 'hdg',
    warnAck: 0,
  };
  let lastFlight: CockpitFlight | null = null;
  const failed = new Set<CockpitComponent>();

  const ctx: CockpitContext = {
    f: null as unknown as CockpitFlight,
    av,
    controls: pilot,
    aux,
    local,
    eye,
    timeSec: 0,
    dtSec: 0,
    speedUnit: SpeedUnit.Knots,
    inv,
    gunRounds: 0,
    unackedWarnings: 0,
  };

  const sunBody = { x: 0, y: 1, z: 0 };
  const upBody = { x: 0, y: 1, z: 0 };
  const WORLD_UP = { x: 0, y: 1, z: 0 };
  const tmpColor = new THREE.Color();

  // Hover highlight: a faint outline glow on the control under the pointer.
  let hovered: CockpitControl | null = null;
  const raycaster = new THREE.Raycaster();
  raycaster.near = 0.02;
  raycaster.far = 3;
  const ndc = new THREE.Vector2();
  const highlight = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x80c8ff, transparent: true, opacity: 0.16, depthWrite: false, depthTest: false })
  );
  highlight.visible = false;
  highlight.renderOrder = 20;
  scene.add(highlight);
  const box3 = new THREE.Box3();
  const sphere = new THREE.Sphere();

  function setHover(c: CockpitControl | null): void {
    hovered = c;
    if (!c) {
      highlight.visible = false;
      return;
    }
    box3.setFromObject(c.target);
    box3.getBoundingSphere(sphere);
    highlight.position.copy(sphere.center);
    highlight.scale.setScalar(Math.max(0.008, sphere.radius * 1.15));
    highlight.visible = true;
  }

  return {
    scene,
    camera,

    head(dtSec) {
      const f = lastFlight;
      fovDeg = updateHead(
        head,
        dtSec,
        {
          g: av.g,
          aoaDeg: av.aoaDeg,
          mach: av.mach,
          iasKt: av.iasKt,
          onGround: f ? (f.flags & EntityFlag.OnGround) !== 0 : true,
          groundSpeedMps: av.gsKt / 1.943844,
        },
        eye,
        rotBody
      );
      eyeBody.copy(eye).add(layout.eyeBody);
      return { eyeBody, rotBody, fovDeg };
    },

    update(f, dtSec, timeSec, aspect) {
      lastFlight = f;
      ctx.f = f;
      ctx.dtSec = dtSec;
      ctx.timeSec = timeSec;
      ctx.speedUnit = aux.speedUnit;
      if (f.valid) {
        updateAvionics(av, avState, f, dtSec);
        storeInventory(f.stores, f.storesB, inv);
      }
      ctx.gunRounds = av.gunRounds;
      // Master warning/caution: a press acknowledges what is showing; new warnings light it again.
      local.warnAck &= av.warnings;
      ctx.unackedWarnings = av.warnings & ~local.warnAck;

      // Camera in the cockpit frame.
      camera.position.copy(eye);
      camera.quaternion.copy(rotBody);
      camera.fov = fovDeg;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      glassU.uEye.value.copy(eye);

      // Light: sun and sky turned into the cockpit frame.
      toBody(f.rot, f.sunDir, sunBody);
      toBody(f.rot, WORLD_UP, upBody);
      sun.position.set(sunBody.x * 4, sunBody.y * 4, sunBody.z * 4);
      sun.target.position.set(0, -0.3, 0);
      sun.target.updateMatrixWorld();
      // The canopy frame and fuselage block the sun when it is below the canopy rail.
      toLinear(f.sunCol, sun.color, 1);
      sun.intensity = Math.PI;
      hemi.position.set(upBody.x, upBody.y, upBody.z);
      toLinear(f.ambSky, hemi.color, 1);
      toLinear(f.ambGround, hemi.groundColor, 1);
      hemi.intensity = Math.PI * 0.9;
      toLinear(f.ambSky, fill.color, 1);
      fill.color.lerp(toLinear(f.sunCol, tmpColor, 1), 0.35);
      fill.intensity = Math.PI * 0.75;
      glassU.uSunDir.value.set(sunBody.x, sunBody.y, sunBody.z);
      glassU.uSunCol.value.setRGB(f.sunCol.r, f.sunCol.g, f.sunCol.b);
      glassU.uSky.value.setRGB(f.ambSky.r, f.ambSky.g, f.ambSky.b);
      glassU.uGround.value.setRGB(f.ambGround.r, f.ambGround.g, f.ambGround.b);

      // Night: flood lights and backlit legends.
      const night = f.night;
      flood.intensity = night * local.floodLights * 0.35;
      tmpColor.setRGB(0.95, 0.72, 0.42).multiplyScalar(night * local.panelLights * 0.9);
      mats.painted.emissive.copy(tmpColor);

      if (!off.has('update'))
        for (const c of components) {
          // One faulty instrument must not take the whole cockpit (and the frame) down with it.
          try {
            c.update?.(ctx);
          } catch (e) {
            if (!failed.has(c)) console.error('cockpit component failed:', e);
            failed.add(c);
          }
        }
      root.visible = !off.has('all');
      if (hovered) setHover(hovered);
    },

    look(dYaw, dPitch, dFov) {
      lookHead(head, dYaw, dPitch, dFov);
    },

    recenter() {
      recenterHead(head);
    },

    setControls(c) {
      Object.assign(pilot, c);
    },

    setAux(a) {
      Object.assign(aux, a);
    },

    pointer(ndcX, ndcY, click, cssX, cssY) {
      if (ndcX === null) {
        setHover(null);
        return { action: null, hover: null };
      }
      ndc.set(ndcX, ndcY);
      raycaster.setFromCamera(ndc, camera);
      // The first solid surface along the ray: a control, or something hiding one.
      const hits = raycaster.intersectObject(root, true);
      let found: CockpitControl | null = null;
      for (const h of hits) {
        const mat = (h.object as THREE.Mesh).material as THREE.Material | undefined;
        if (h.object.userData.noPick || (mat && mat.transparent)) continue;
        found = controls.find((c) => c.target === h.object || isAncestor(c.target, h.object)) ?? null;
        break;
      }
      setHover(found);
      if (!found || !ctx.f) return { action: null, hover: null };
      const action = click ? found.press(ctx) : null;
      return { action, hover: { label: found.label(ctx), x: cssX, y: cssY } };
    },

    setShadowQuality(size) {
      sun.castShadow = size > 0;
      if (size > 0 && sun.shadow.mapSize.x !== size) {
        sun.shadow.mapSize.set(size, size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
      }
    },

    dispose() {
      for (const c of components) c.dispose?.();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of mats.all) m.dispose();
      atlas.colorTexture.dispose();
      atlas.glowTexture.dispose();
      sun.shadow.map?.dispose();
    },
  };
}

function isAncestor(a: THREE.Object3D, b: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = b.parent; o; o = o.parent) if (o === a) return true;
  return false;
}
