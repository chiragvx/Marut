/**
 * src/render/cockpit/components/panel.ts — flat panels with painted faces.
 *
 * A panel is a plate of any outline (panel-local metres, x right, y up) in a frame placed by the
 * layout, with its face painted into the shared atlas: legends, placards, stencils, fasteners,
 * wear. Instruments and switches then mount on the face at z = 0 in the same frame.
 */

import * as THREE from 'three';
import { mul, local, type Painter } from '../build';
import type { CockpitKit } from '../index';

export interface PanelPaint {
  /** Painter with coordinates converted from panel metres: x(m), y(m) -> mm on the face. */
  (p: Painter, at: (x: number, y: number) => [number, number]): void;
}

export interface PanelSpec {
  /** Outline, panel-local metres, counter-clockwise. */
  outline: readonly (readonly [number, number])[];
  /** Plate thickness behind the face, m. */
  depth?: number;
  /** Base colour of the face (CSS). */
  color?: string;
  paint?: PanelPaint;
  /** Wear amount 0..1. */
  wear?: number;
  /** Fastener inset, mm (0 = none). */
  fasteners?: number;
  /** Texture density (big plain panels need less). */
  pxPerMm?: number;
}

const BEVEL = 0.0015;

/** Adds a painted panel to the batch in `frame`. The face is at z = 0 (a hair in front, over the bevel). */
export function addPanel(kit: CockpitKit, frame: THREE.Matrix4, spec: PanelSpec): void {
  const xs = spec.outline.map((p) => p[0]);
  const ys = spec.outline.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const wMm = (maxX - minX) * 1000;
  const hMm = (maxY - minY) * 1000;
  const at = (x: number, y: number): [number, number] => [(x - minX) * 1000, (maxY - y) * 1000];
  const region = kit.atlas.paint(wMm, hMm, (p) => {
    p.fill(spec.color ?? '#8c9193');
    spec.paint?.(p, at);
    if (spec.fasteners) p.fasteners(spec.fasteners);
    p.wear(spec.wear ?? 0.8);
  }, spec.pxPerMm ?? 2.4);
  const shape = new THREE.Shape(spec.outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const face = new THREE.ShapeGeometry(shape);
  const uv = face.getAttribute('uv') as THREE.BufferAttribute;
  const pos = face.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const u = (pos.getX(i) - minX) / (maxX - minX);
    const v = (pos.getY(i) - minY) / (maxY - minY);
    uv.setXY(i, region.u0 + u * (region.u1 - region.u0), region.v0 + v * (region.v1 - region.v0));
  }
  // Just in front of the plate's bevelled front face.
  kit.batch.add(face, kit.mats.painted, mul(frame, local(0, 0, BEVEL + 0.0003)));
  const depth = spec.depth ?? 0.02;
  const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize: BEVEL, bevelThickness: BEVEL, bevelSegments: 1 });
  body.translate(0, 0, -depth);
  kit.batch.add(body, kit.mats.panel, frame);
}

/** A rectangle outline centred on (cx, cy). */
export function rectOutline(cx: number, cy: number, w: number, h: number): [number, number][] {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
}
