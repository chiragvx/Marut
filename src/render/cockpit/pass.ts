/**
 * src/render/cockpit/pass.ts — draws the cockpit over the world in the composer's buffer.
 *
 * Runs after the world's RenderPass and before anti-aliasing/grading, so the cockpit is graded
 * and anti-aliased with the world. It clears only depth (the cockpit has its own near/far range),
 * after binding the buffer (three's RenderPass clears depth before binding, i.e. the wrong one).
 */

import type * as THREE from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const PIT_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('pitdebug');

export class CockpitPass extends Pass {
  scene: THREE.Scene | null = null;
  camera: THREE.Camera | null = null;

  constructor() {
    super();
    this.needsSwap = false;
    this.enabled = false;
  }

  override render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    if (!this.scene || !this.camera) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.clearDepth();
    // Dev aid: ?pitdebug paints everything the cockpit doesn't cover magenta (finds holes in the shell).
    if (PIT_DEBUG) {
      renderer.setClearColor(0xff00ff, 1);
      renderer.clearColor();
    }
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }
}
