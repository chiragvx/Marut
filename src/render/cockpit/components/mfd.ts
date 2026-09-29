/**
 * src/render/cockpit/components/mfd.ts — a multi-function display unit.
 *
 * A 5 x 5 in AMLCD in a black bezel: five square option-select buttons (OSBs) along the top and
 * bottom, four round ones down each side, a brightness knob in the top right corner and rockers in
 * the other corners (as on the Tejas's BEL MFDs). The top and bottom OSBs select pages; the side
 * OSBs do what the current page labels them with. Pages: mfdPages.ts.
 */

import * as THREE from 'three';
import { cylZ, decalGeometry, local, mul, roundedSlab } from '../build';
import type { CockpitKit } from '../index';
import { CanvasScreen } from '../screen';
import type { CockpitComponent, CockpitContext, CockpitControl } from '../types';
import { BOTTOM_MENU, MFD_BG, MFD_PAGES, OSB_X, OSB_Y, TOP_MENU, drawFrame, type MfdConfig, type MfdState } from './mfdPages';

export interface MfdOptions {
  id: string;
  /** Active area (square), m. */
  screen: number;
  config: MfdConfig;
}

const BRIGHTNESS = [1, 0.7, 0.45, 0.25];

export function createMfd(kit: CockpitKit, frame: THREE.Matrix4, o: MfdOptions): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  const S = o.screen;
  const bw = S + 0.05;
  const bh = S + 0.064;
  const depth = 0.034;
  // Bezel: a rounded black slab with the screen recessed a little.
  kit.batch.add(roundedSlab(bw, bh, depth, 0.008, 0.002, { w: S + 0.004, h: S + 0.004, r: 0.002 }), kit.mats.bezel, mul(frame, local(0, 0, depth / 2 - 0.004)));
  // Printed bezel legends (small decals, not the whole bezel face).
  const legend = (t: string, x: number, y: number): void => {
    const r = kit.atlas.paint(10, 4.5, (p) => {
      p.fill('#151617');
      p.text(t, 5, 2.3, 2.6, { color: '#d8d8d2' });
    }, 4);
    kit.batch.add(decalGeometry(r), kit.mats.painted, mul(frame, local(x, y, depth - 0.0036)));
  };
  legend('BRT', S / 2 + 0.013, S / 2 + 0.0265);
  legend('CON', -(S / 2 + 0.013), S / 2 + 0.0255);
  legend('SYM', -(S / 2 + 0.013), -S / 2 - 0.0255);
  legend('GAIN', S / 2 + 0.013, -S / 2 - 0.0255);

  const screen = new CanvasScreen(S, S, 512, 512, 24);
  // Recessed 4 mm behind the bezel face.
  screen.mesh.position.z = depth - 0.008;
  object.add(screen.mesh);
  // Screen surround: a thin dark frame round the glass inside the bezel opening.
  kit.batch.add(roundedSlab(S + 0.008, S + 0.008, 0.002, 0.002, 0.0003), kit.mats.rubber, mul(frame, local(0, 0, depth - 0.0105)));

  const controls: CockpitControl[] = [];
  const buttons: { mesh: THREE.Object3D; pressedAt: number; rest: number }[] = [];
  const osb = (x: number, y: number, round: boolean, label: (ctx: CockpitContext) => string, press: CockpitControl['press']): void => {
    const g = round ? cylZ(0.0052, 0.0048, 0.006, 16) : roundedSlab(0.0105, 0.0085, 0.006, 0.0012, 0.0006).translate(0, 0, 0.003);
    const mesh = new THREE.Mesh(g, kit.mats.keycap);
    mesh.position.set(x, y, depth - 0.004);
    object.add(mesh);
    const b = { mesh, pressedAt: -1, rest: mesh.position.z };
    buttons.push(b);
    controls.push({
      target: mesh,
      label,
      press(ctx) {
        b.pressedAt = ctx.timeSec;
        return press(ctx);
      },
    });
  };
  const page = (ctx: CockpitContext): string => ctx.local.mfdPage[o.id] ?? 'PFD';
  TOP_MENU.forEach((name, i) => {
    osb((OSB_X[i]! - 0.5) * S, S / 2 + 0.0145, false, () => `${o.id}MFD: ${name} page`, (ctx) => ((ctx.local.mfdPage[o.id] = name), null));
  });
  BOTTOM_MENU.forEach((name, i) => {
    osb(
      (OSB_X[i]! - 0.5) * S,
      -S / 2 - 0.0145,
      false,
      () => (name ? `${o.id}MFD: ${name} page` : `${o.id}MFD: spare`),
      (ctx) => {
        if (name) ctx.local.mfdPage[o.id] = name;
        return null;
      }
    );
  });
  for (const side of ['left', 'right'] as const) {
    OSB_Y.forEach((fy, i) => {
      const x = (side === 'left' ? -1 : 1) * (S / 2 + 0.0125);
      osb(
        x,
        (0.5 - fy) * S,
        true,
        (ctx) => {
          const k = MFD_PAGES[page(ctx)]?.[side]?.[i];
          return k ? `${o.id}MFD: ${k.legend.replace('\n', ' ')}` : `${o.id}MFD: OSB ${side === 'left' ? 'L' : 'R'}${i + 1}`;
        },
        (ctx) => MFD_PAGES[page(ctx)]?.[side]?.[i]?.press(ctx) ?? null
      );
    });
  }
  // Brightness knob (top right): steps through day and night brightness.
  let brightIdx = 0;
  const knobMesh = new THREE.Mesh(cylZ(0.0062, 0.0058, 0.008, 18), kit.mats.bezel);
  knobMesh.position.set(S / 2 + 0.013, S / 2 + 0.0165, depth - 0.004);
  object.add(knobMesh);
  controls.push({
    target: knobMesh,
    label: () => `${o.id}MFD brightness: ${Math.round(BRIGHTNESS[brightIdx]! * 100)} %`,
    press: () => {
      brightIdx = (brightIdx + 1) % BRIGHTNESS.length;
      return null;
    },
  });
  // Corner rockers (contrast, symbology, gain): shaped, not wired to anything.
  for (const [x, y] of [
    [-(S / 2 + 0.013), S / 2 + 0.0145],
    [-(S / 2 + 0.013), -S / 2 - 0.0145],
    [S / 2 + 0.013, -S / 2 - 0.0145],
  ] as const) {
    kit.batch.add(roundedSlab(0.007, 0.014, 0.005, 0.002, 0.0008), kit.mats.keycap, mul(frame, local(x, y, depth - 0.0015)));
  }

  const st: MfdState = { id: o.id, sweep: 0 };
  return {
    object,
    controls,
    update(ctx) {
      const name = page(ctx);
      const pg = MFD_PAGES[name] ?? MFD_PAGES.PFD!;
      screen.refresh(ctx.timeSec, (g, W, H) => {
        g.fillStyle = MFD_BG;
        g.fillRect(0, 0, W, H);
        if (!ctx.f.valid) return;
        pg.draw(g, W, H, ctx, o.config, st);
        drawFrame(g, W, H, pg, ctx);
      });
      // Sunlight-readable by day (bright), dimmed at night.
      screen.setBrightness(BRIGHTNESS[brightIdx]! * (0.55 + 0.9 * (1 - ctx.f.night)));
      for (const b of buttons) b.mesh.position.z = b.rest - (b.pressedAt >= 0 && ctx.timeSec - b.pressedAt < 0.15 ? 0.002 : 0);
    },
    dispose() {
      screen.dispose();
    },
  };
}
