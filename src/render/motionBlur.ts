/**
 * src/render/motionBlur.ts — camera-turn motion blur.
 *
 * Only the camera's rotation since the last frame drives it (no velocity buffer): each pixel's view
 * ray is turned back into the previous frame's view, which gives its screen motion, and the image
 * is averaged along it. Turning is what moves the picture in a flight sim (hard rolls, the chase
 * view swinging round, snapping the head round in the cockpit); straight-line speed far from the
 * ground barely moves it.
 *
 * - A dead zone on the turn rate keeps steady flight and gentle manoeuvring sharp (aiming must
 *   stay crisp); the pass is switched off entirely while nothing blurs, so it costs nothing then.
 * - The blur length is what a camera shutter of SHUTTER_SEC would see at the current turn rate,
 *   capped, whatever the frame rate.
 * - Your own jet (and what it carries) stays sharp: it moves with the camera. Pixels nearer than the
 *   jet's far side and inside its circle on screen are masked out, both as blur centres and as
 *   samples (so the background doesn't smear over it either). It runs before the 3D cockpit pass,
 *   so the cockpit is never blurred.
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** Exposure the blur imitates, s (strength 1). */
const SHUTTER_SEC = 1 / 45;
/** Turn rates below this don't blur, rad/s (~25 deg/s); the blur grows from it. */
export const BLUR_DEADZONE_RAD_S = 0.44;
/** Longest blur, as a fraction of the screen height. */
const MAX_BLUR_FRAC = 0.07;
/** A turn bigger than this in one frame is a camera cut (view change), not motion, rad. */
const CUT_RAD = 0.5;
const TAPS = 10;

const VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FS = /* glsl */ `
  #include <packing>
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform mat3 uDelta;      // current view -> previous view rotation
  uniform vec2 uTanHalf;    // tan(half fov) x (with the aspect), y
  uniform float uScale;     // screen motion per frame -> blur length
  uniform float uMaxLen;    // uv
  uniform float uAspect;
  uniform float uNear;
  uniform float uFar;
  uniform vec3 uJet;        // own jet: uv x, uv y, radius on screen (in screen heights; 0 = no mask)
  uniform vec2 uJetDepth;   // own jet: view distance of its far side, m; 1 when the camera is inside its radius
  varying vec2 vUv;

  float viewDist(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    return -perspectiveDepthToViewZ(d, uNear, uFar);
  }
  bool ownJet(vec2 uv) {
    if (uJet.z <= 0.0) return false;
    vec2 o = (uv - uJet.xy) * vec2(uAspect, 1.0);
    return dot(o, o) < uJet.z * uJet.z && viewDist(uv) < uJetDepth.x;
  }
  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    // This pixel's view ray, turned into the previous frame's view, projected.
    vec3 d = vec3((vUv * 2.0 - 1.0) * uTanHalf, -1.0);
    vec3 p = uDelta * d;
    vec2 prev = vUv;
    if (p.z < -1e-3) prev = (p.xy / -p.z) / uTanHalf * 0.5 + 0.5;
    vec2 vel = (vUv - prev) * uScale;
    float len = length(vel * vec2(uAspect, 1.0));
    if (len > uMaxLen) vel *= uMaxLen / len;
    // Under ~1 px, or on the jet itself: as is.
    if (len * 1080.0 < 1.0 || ownJet(vUv)) {
      gl_FragColor = base;
      return;
    }
    vec3 acc = base.rgb;
    float w = 1.0;
    for (int i = 0; i < ${TAPS}; i++) {
      float t = float(i) / float(${TAPS - 1}) - 0.5;
      vec2 uv = vUv + vel * t;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 || ownJet(uv)) continue;
      acc += texture2D(tDiffuse, uv).rgb;
      w += 1.0;
    }
    gl_FragColor = vec4(acc / w, base.a);
  }
`;

export interface MotionBlurFrame {
  /** Camera orientation this frame (world). */
  rot: THREE.Quaternion;
  camera: THREE.PerspectiveCamera;
  dtSec: number;
  /** Own jet: world-space centre relative to the camera, and its radius, m; undefined = no mask. */
  jetRel?: THREE.Vector3;
  jetRadiusM: number;
}

/** Turn-rate scale for the blur: 0 inside the dead zone, then the shutter's share of the frame's turn. */
export function blurScale(turnRad: number, dtSec: number, strength: number): number {
  if (strength <= 0 || dtSec <= 0 || turnRad <= 0 || turnRad > CUT_RAD) return 0;
  const rate = turnRad / dtSec;
  const eff = Math.max(0, rate - BLUR_DEADZONE_RAD_S);
  if (eff <= 0) return 0;
  // Per-frame screen motion (turnRad) -> what the shutter sees at the effective rate.
  return (strength * eff * SHUTTER_SEC) / turnRad;
}

export class MotionBlurPass extends Pass {
  strength = 0.6;
  private readonly mat: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly prev = new THREE.Quaternion();
  private hasPrev = false;
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpV = new THREE.Vector3();

  constructor() {
    super();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uDelta: { value: new THREE.Matrix3() },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        uScale: { value: 0 },
        uMaxLen: { value: MAX_BLUR_FRAC },
        uAspect: { value: 1 },
        uNear: { value: 0.5 },
        uFar: { value: 1000 },
        uJet: { value: new THREE.Vector3() },
        uJetDepth: { value: new THREE.Vector2() },
      },
      vertexShader: VS,
      fragmentShader: FS,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.mat);
    this.enabled = false;
  }

  /** Call once per frame before composer.render(): sets up (or switches off) this frame's blur. */
  frame(f: MotionBlurFrame): void {
    const had = this.hasPrev;
    this.tmpQ.copy(this.prev).invert().multiply(f.rot); // current view -> previous view
    this.prev.copy(f.rot);
    this.hasPrev = true;
    const w = Math.min(1, Math.abs(this.tmpQ.w));
    const turn = 2 * Math.acos(w);
    const scale = had ? blurScale(turn, f.dtSec, this.strength) : 0;
    this.enabled = scale > 0;
    if (!this.enabled) return;
    const u = this.mat.uniforms;
    (u['uDelta']!.value as THREE.Matrix3).setFromMatrix4(this.tmpM.makeRotationFromQuaternion(this.tmpQ));
    const cam = f.camera;
    const tanY = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / Math.max(1e-6, cam.zoom);
    (u['uTanHalf']!.value as THREE.Vector2).set(tanY * cam.aspect, tanY);
    u['uScale']!.value = scale;
    u['uAspect']!.value = cam.aspect;
    u['uNear']!.value = cam.near;
    u['uFar']!.value = cam.far;
    const jet = u['uJet']!.value as THREE.Vector3;
    jet.set(0, 0, 0);
    if (f.jetRel) {
      const dist = f.jetRel.length();
      (u['uJetDepth']!.value as THREE.Vector2).set(dist + f.jetRadiusM, 1);
      if (dist <= f.jetRadiusM * 1.2) {
        jet.set(0.5, 0.5, 10); // inside it (cockpit): the whole screen, by depth alone
      } else {
        // Project the centre (view space) and the radius it subtends.
        const v = this.tmpV.copy(f.jetRel).applyQuaternion(this.tmpQ.copy(f.rot).invert());
        if (v.z < 0) {
          const sx = v.x / -v.z / (tanY * cam.aspect);
          const sy = v.y / -v.z / tanY;
          const r = f.jetRadiusM / dist / (2 * tanY);
          jet.set(sx * 0.5 + 0.5, sy * 0.5 + 0.5, r * 1.15);
        }
      }
    }
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.mat.uniforms['tDiffuse']!.value = readBuffer.texture;
    this.mat.uniforms['tDepth']!.value = readBuffer.depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.mat.dispose();
    this.quad.dispose();
  }
}
