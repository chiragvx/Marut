/**
 * src/render/cockpit/screen.ts — a glass display whose picture is drawn with Canvas 2D.
 *
 * The screen is a glossy black glass face (it catches sun glints and washes out in direct sun, as
 * real AMLCDs do) with the picture as its emissive map. The picture is redrawn at `hz` (displays
 * refresh their symbology well below the frame rate, and it keeps the cost down), staggered so
 * the displays don't all redraw on the same frame.
 */

import * as THREE from 'three';

/** The avionics display font (a condensed sans, like the stroke fonts on real MFDs). */
export const DISPLAY_FONT = '"Arial Narrow", "Roboto Condensed", Arial, sans-serif';

let stagger = 0;
const DEV_OFF = new Set(typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('pitoff') ?? '').split(',') : []);

export class CanvasScreen {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshStandardMaterial;
  readonly mesh: THREE.Mesh;
  /** Picture size in canvas px. */
  readonly w: number;
  readonly h: number;
  private next = 0;
  private readonly period: number;
  private failed = false;

  /**
   * @param wM, hM  glass size, m
   * @param wPx, hPx  canvas size
   */
  constructor(wM: number, hM: number, wPx: number, hPx: number, hz = 20) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w = wPx;
    this.canvas.height = this.h = hPx;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    // A plain RGBA texture, decoded from sRGB in the shader: uploading a canvas into an sRGB
    // texture takes Chrome's slow path (about 1 ms per upload on an Intel iGPU, against almost
    // nothing for a plain one). Seen at about 1:1, so no mipmaps to rebuild on every redraw.
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.material = new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.38, metalness: 0, emissive: 0xffffff, emissiveMap: this.texture, emissiveIntensity: 1 });
    this.material.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= pow( texture2D( emissiveMap, vEmissiveMapUv ).rgb, vec3( 2.2 ) );')
        .replace('#include <colorspace_fragment>', 'gl_FragColor = sRGBTransferOETF( gl_FragColor );');
    };
    this.material.customProgramCacheKey = () => 'cockpit-screen';
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), this.material);
    this.mesh.receiveShadow = true;
    this.period = 1 / hz;
    this.next = (stagger++ % 7) * (this.period / 7);
  }

  /** Redraws when due (or `force`). Returns true if it drew. */
  refresh(timeSec: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, force = false): boolean {
    if (!force && timeSec < this.next) return false;
    if (DEV_OFF.has('canvas')) return false;
    this.next = Math.max(this.next + this.period, timeSec);
    // A failing page must not stop the rest of the cockpit: report it once and show what was drawn.
    this.ctx.save();
    try {
      draw(this.ctx, this.w, this.h);
    } catch (e) {
      if (!this.failed) console.error('cockpit display failed to draw:', e);
      this.failed = true;
    }
    this.ctx.restore();
    this.texture.needsUpdate = true;
    return true;
  }

  /** Display brightness (emissive), 0..~1.5. */
  setBrightness(b: number): void {
    this.material.emissiveIntensity = b;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/** Text helper: `font(ctx, px, bold)`. */
export function font(ctx: CanvasRenderingContext2D, px: number, bold = false): void {
  ctx.font = `${bold ? 'bold ' : ''}${px}px ${DISPLAY_FONT}`;
}
