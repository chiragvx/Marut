/**
 * src/render/cockpit/components/ufcp.ts — the up-front control panel.
 *
 * On the Tejas it sits on the HUD's face: a 12-key keypad on the left, a yellow-green
 * transflective LCD in the middle, round keys on the right and a row of function keys under it.
 * Here it is the autopilot's control head: the function keys pick the bug (HDG, ALT, SPD, V/S),
 * digits + ENT set it, the arrow keys step it, AP and A/T engage and disengage.
 */

import * as THREE from 'three';
import type { AutopilotAction } from '../../../contracts/core';
import type { CockpitAction } from '../../../contracts/render';
import { apEngaged, atEngaged, fmtHdg } from '../avionics';
import { decalGeometry, local, mul, roundedSlab } from '../build';
import type { CockpitKit } from '../index';
import { CanvasScreen, font } from '../screen';
import type { CockpitComponent, CockpitContext, CockpitControl } from '../types';

const DEG = Math.PI / 180;
type Field = 'hdg' | 'alt' | 'spd' | 'vs';
const FIELD_NAMES: Record<Field, string> = { hdg: 'HDG', alt: 'ALT', spd: 'SPD', vs: 'V/S' };

/** Bug value in cockpit units, and the SI delta to reach `value` from it. */
function bugValue(ctx: CockpitContext, f: Field): number {
  const av = ctx.av;
  return f === 'hdg' ? av.apHdgDeg : f === 'alt' ? av.apAltFt : f === 'spd' ? av.apSpdKt : av.apVsFpm;
}
function deltaSi(f: Field, fromUnits: number, toUnits: number): number {
  const d = toUnits - fromUnits;
  if (f === 'hdg') return ((((d + 540) % 360) - 180) * DEG);
  if (f === 'alt') return d / 3.280839;
  if (f === 'spd') return d / 1.943844;
  return d / 196.8504;
}
const STEP: Record<Field, number> = { hdg: 1, alt: 100, spd: 5, vs: 100 };

export function createUfcp(kit: CockpitKit, frame: THREE.Matrix4, size: { w: number; h: number }): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  const { w, h } = size;
  const depth = 0.02;
  kit.batch.add(roundedSlab(w, h, depth, 0.006, 0.0015), kit.mats.bezel, mul(frame, local(0, 0, depth / 2 - 0.006)));

  // LCD.
  const lcdW = w * 0.37;
  const lcdH = h * 0.5;
  const lcdY = h * 0.12;
  const lcdX = w * 0.055;
  const screen = new CanvasScreen(lcdW, lcdH, 320, 220, 10);
  screen.mesh.position.set(lcdX, lcdY, depth - 0.0055);
  object.add(screen.mesh);

  let scratch = '';
  let flash = '';
  let flashUntil = 0;
  const controls: CockpitControl[] = [];
  const keys: { mesh: THREE.Object3D; pressedAt: number }[] = [];
  const key = (x: number, y: number, kw: number, kh: number, legend: string, cap: string, ink: string, label: string | ((c: CockpitContext) => string), press: (c: CockpitContext) => CockpitAction | null, round = false): void => {
    const g = new THREE.Group();
    g.position.set(x, y, depth - 0.006);
    const body = new THREE.Mesh(round ? new THREE.CylinderGeometry(kw / 2, kw / 2, 0.006, 18).rotateX(Math.PI / 2).translate(0, 0, 0.003) : roundedSlab(kw, kh, 0.006, 0.0015, 0.0007).translate(0, 0, 0.003), kit.mats.keycap);
    g.add(body);
    const region = kit.atlas.paint(kw * 1000, kh * 1000, (p) => {
      p.fill(cap);
      const lines = legend.split('\n');
      const s = Math.min(3.4, (kh * 1000 * 0.55) / lines.length);
      lines.forEach((l, i) => p.text(l, p.wMm / 2, p.hMm / 2 + (i - (lines.length - 1) / 2) * s * 1.1, s, { color: ink, bold: true }));
    });
    const face = new THREE.Mesh(round ? new THREE.CircleGeometry(kw / 2 - 0.0004, 18) : decalGeometry(region), kit.mats.painted);
    if (round) {
      const uv = face.geometry.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, region.u0 + uv.getX(i) * (region.u1 - region.u0), region.v0 + uv.getY(i) * (region.v1 - region.v0));
    }
    face.position.z = 0.0062;
    g.add(face);
    object.add(g);
    const k = { mesh: g, pressedAt: -1 };
    keys.push(k);
    controls.push({
      target: g,
      label: typeof label === 'string' ? () => label : label,
      press(c) {
        k.pressedAt = c.timeSec;
        return press(c);
      },
    });
  };
  const ap = (a: AutopilotAction): CockpitAction => ({ kind: 'autopilot', action: a });
  const show = (c: CockpitContext, s: string): void => {
    flash = s;
    flashUntil = c.timeSec + 1.5;
  };

  // Keypad: 3 x 4 on the left.
  const kx0 = -w / 2 + 0.013;
  const kw = 0.0135;
  const kh = 0.0115;
  const pad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', 'ENT'];
  pad.forEach((d, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = kx0 + col * (kw + 0.0035);
    const y = h / 2 - 0.016 - row * (kh + 0.0035);
    const isDigit = /\d/.test(d);
    key(x, y, kw, kh, d, isDigit ? '#c9b8c2' : '#b9bcbc', '#1c1c1c', isDigit ? `UFCP ${d}` : d === 'CLR' ? 'UFCP CLEAR' : 'UFCP ENTER', (c) => {
      if (isDigit) {
        if (scratch.length < 5) scratch += d;
        return null;
      }
      if (d === 'CLR') {
        scratch = '';
        return null;
      }
      // ENT: set the selected bug to the typed value.
      if (!scratch) return null;
      const f = c.local.ufcpField;
      let v = Number(scratch);
      scratch = '';
      if (f === 'hdg') v = ((v % 360) + 360) % 360;
      show(c, `${FIELD_NAMES[f]} SET ${v}`);
      return ap({ type: 'adjust', target: f, delta: deltaSi(f, bugValue(c, f), v) });
    });
  });
  // Right column: AP, A/T, up/down.
  const rx = w / 2 - 0.016;
  const right: [string, string, (c: CockpitContext) => CockpitAction | null, (c: CockpitContext) => string][] = [
    ['AP', '#2a5ca8', () => ap({ type: 'toggleAp' }), (c) => `Autopilot: ${apEngaged(c.av) ? 'ENGAGED (press to disengage)' : 'off (press to engage)'}`],
    ['A/T', '#2a5ca8', () => ap({ type: 'toggleAt' }), (c) => `Autothrottle: ${atEngaged(c.av) ? 'ENGAGED' : 'off'}`],
    ['▲', '#2a5ca8', (c) => ap({ type: 'adjust', target: c.local.ufcpField, delta: deltaSi(c.local.ufcpField, 0, STEP[c.local.ufcpField]) }), (c) => `${FIELD_NAMES[c.local.ufcpField]} up`],
    ['▼', '#2a5ca8', (c) => ap({ type: 'adjust', target: c.local.ufcpField, delta: deltaSi(c.local.ufcpField, 0, -STEP[c.local.ufcpField]) }), (c) => `${FIELD_NAMES[c.local.ufcpField]} down`],
  ];
  right.forEach(([lg, cap, press, label], i) => key(rx, h / 2 - 0.016 - i * 0.015, 0.0125, 0.0125, lg, cap, '#f0f0f0', label, press, true));
  // Function keys under the LCD: pick the bug the keypad and arrows set.
  (['hdg', 'alt', 'spd', 'vs'] as Field[]).forEach((f, i) => {
    const x = lcdX - lcdW / 2 + 0.008 + i * ((lcdW - 0.016) / 3);
    key(x, lcdY - lcdH / 2 - 0.011, 0.0145, 0.009, FIELD_NAMES[f], '#2f4a2c', '#8cf07a', (c) => `UFCP: set ${FIELD_NAMES[f]} (now ${Math.round(bugValue(c, f))})`, (c) => {
      c.local.ufcpField = f;
      return null;
    });
  });
  // Mission key (shows the mission on the LCD).
  key(lcdX - lcdW / 2 + 0.008, -h / 2 + 0.01, 0.0145, 0.009, 'MSN', '#2f4a2c', '#8cf07a', 'UFCP: mission', (c) => {
    show(c, (c.aux.missionName ?? 'FREE FLIGHT').toUpperCase().slice(0, 20));
    return null;
  });
  key(lcdX - lcdW / 2 + 0.008 + (lcdW - 0.016) / 3, -h / 2 + 0.01, 0.0145, 0.009, 'TAXI', '#2f4a2c', '#8cf07a', 'Taxi guidance (on the ground)', () => ({ kind: 'taxiGuide' }));

  const lcdInk = '#1a2410';
  return {
    object,
    controls,
    update(c) {
      screen.refresh(c.timeSec, (g, W, H) => {
        // Transflective LCD: yellow-green background, dark segments.
        const grd = g.createLinearGradient(0, 0, 0, H);
        grd.addColorStop(0, '#c5d86a');
        grd.addColorStop(1, '#adc25a');
        g.fillStyle = grd;
        g.fillRect(0, 0, W, H);
        g.fillStyle = lcdInk;
        g.textBaseline = 'middle';
        const av = c.av;
        const line = (s: string, y: number, align: CanvasTextAlign = 'left', x = 12): void => {
          g.textAlign = align;
          g.fillText(s, x, y);
        };
        font(g, 26, true);
        line(`AP ${apEngaged(av) ? (av.apFlags & 4 ? 'VS' : 'ALT') : 'OFF'}`, 28);
        line(`A/T ${atEngaged(av) ? 'ON' : 'OFF'}`, 28, 'right', W - 12);
        font(g, 24, false);
        const sel = c.local.ufcpField;
        const cell = (f: Field, text: string, x: number, y: number): void => {
          if (f === sel) {
            g.fillRect(x - 6, y - 15, 146, 30);
            g.fillStyle = '#c5d86a';
            line(text, y, 'left', x);
            g.fillStyle = lcdInk;
          } else line(text, y, 'left', x);
        };
        cell('hdg', `HDG ${fmtHdg(av.apHdgDeg)}`, 12, 72);
        cell('alt', `ALT ${Math.round(av.apAltFt / 10) * 10}`, 164, 72);
        cell('spd', `SPD ${Math.round(av.apSpdKt)}`, 12, 112);
        cell('vs', `V/S ${av.apVsFpm >= 0 ? '+' : ''}${Math.round(av.apVsFpm / 10) * 10}`, 164, 112);
        g.fillRect(8, 138, W - 16, 2);
        font(g, 26, true);
        if (c.timeSec < flashUntil) line(flash, 172);
        else line(`${FIELD_NAMES[sel]} > ${scratch}${Math.floor(c.timeSec * 2) % 2 ? '_' : ' '}`, 172);
        font(g, 18);
        line(`${c.aux.lightMode.toUpperCase()}`, 204);
        line(c.aux.masterArm ? 'ARM' : 'SAFE', 204, 'right', W - 12);
      });
      screen.setBrightness(0.55 + 0.25 * (1 - c.f.night));
      for (const k of keys) k.mesh.position.z = depth - 0.006 - (k.pressedAt >= 0 && c.timeSec - k.pressedAt < 0.15 ? 0.002 : 0);
    },
    dispose() {
      screen.dispose();
    },
  };
}
