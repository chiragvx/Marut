/**
 * src/render/cockpit/components/ssdu.ts — a Smart Standby Display Unit.
 *
 * The Tejas has two, one above each side MFD (small square AMLCDs). 'attitude' is the standby
 * flight display (attitude ball with airspeed, altitude and heading, the "get you home" set);
 * 'engine' shows standby engine and fuel data as bars. Both work off the same aircraft data as
 * the main displays (a real SSDU has its own sensors; here there's one truth).
 */

import * as THREE from 'three';
import { fmtHdg } from '../avionics';
import { cylZ, local, mul, roundedSlab } from '../build';
import type { CockpitKit } from '../index';
import { CanvasScreen, font } from '../screen';
import type { CockpitComponent } from '../types';

const DEG = Math.PI / 180;

export function createSsdu(kit: CockpitKit, frame: THREE.Matrix4, o: { screen: number; kind: 'attitude' | 'engine' }): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  const S = o.screen;
  const bw = S + 0.024;
  const bh = S + 0.024;
  const depth = 0.03;
  kit.batch.add(roundedSlab(bw, bh, depth, 0.005, 0.0015, { w: S + 0.003, h: S + 0.003, r: 0.0015 }), kit.mats.bezel, mul(frame, local(0, 0, depth / 2 - 0.004)));
  kit.batch.add(roundedSlab(S + 0.006, S + 0.006, 0.002, 0.0015, 0.0003), kit.mats.rubber, mul(frame, local(0, 0, depth - 0.0095)));
  // Four small buttons along the bottom edge.
  for (let i = 0; i < 4; i++) kit.batch.add(cylZ(0.0032, 0.003, 0.004, 12), kit.mats.keycap, mul(frame, local(-S / 2 + (i + 0.5) * (S / 4), -S / 2 - 0.0065, depth - 0.004)));
  const screen = new CanvasScreen(S, S, 256, 256, 20);
  screen.mesh.position.z = depth - 0.007;
  object.add(screen.mesh);

  return {
    object,
    update(ctx) {
      const { av } = ctx;
      screen.refresh(ctx.timeSec, (g, W, H) => {
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
        if (!ctx.f.valid) return;
        if (o.kind === 'attitude') {
          const cx = W / 2;
          const cy = H / 2 + 6;
          const ppd = 3.4;
          g.save();
          g.beginPath();
          g.rect(0, 0, W, H);
          g.clip();
          g.translate(cx, cy);
          g.rotate(-av.rollDeg * DEG);
          g.translate(0, av.pitchDeg * ppd);
          g.fillStyle = '#2a73d6';
          g.fillRect(-400, -800, 800, 800);
          g.fillStyle = '#8a5a26';
          g.fillRect(-400, 0, 800, 800);
          g.strokeStyle = '#fff';
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(-400, 0);
          g.lineTo(400, 0);
          g.stroke();
          g.lineWidth = 1.5;
          for (let p = -40; p <= 40; p += 10) {
            if (!p) continue;
            g.beginPath();
            g.moveTo(-26, -p * ppd);
            g.lineTo(26, -p * ppd);
            g.stroke();
          }
          g.restore();
          g.strokeStyle = '#ffd400';
          g.lineWidth = 4;
          g.beginPath();
          g.moveTo(cx - 44, cy);
          g.lineTo(cx - 14, cy);
          g.lineTo(cx - 6, cy + 8);
          g.moveTo(cx + 44, cy);
          g.lineTo(cx + 14, cy);
          g.lineTo(cx + 6, cy + 8);
          g.stroke();
          // Airspeed (left), altitude (right), heading (bottom): black boxes like the photo's tapes.
          const box = (x: number, y: number, w: number, s: string): void => {
            g.fillStyle = 'rgba(0,0,0,0.75)';
            g.fillRect(x, y, w, 26);
            g.strokeStyle = '#fff';
            g.lineWidth = 1.5;
            g.strokeRect(x, y, w, 26);
            font(g, 19, true);
            g.fillStyle = '#fff';
            g.textAlign = 'center';
            g.textBaseline = 'middle';
            g.fillText(s, x + w / 2, y + 13);
          };
          box(4, cy - 13, 54, String(Math.round(av.iasKt)));
          box(W - 72, cy - 13, 68, String(Math.round(av.altFt / 10) * 10));
          box(cx - 26, H - 30, 52, fmtHdg(av.headingDeg));
          font(g, 14);
          g.fillStyle = '#fff';
          g.textAlign = 'left';
          g.fillText(`M${av.mach.toFixed(2)}`, 6, 16);
          g.textAlign = 'right';
          g.fillText(`${av.vsFpm >= 0 ? '+' : ''}${Math.round(av.vsFpm / 100) * 100}`, W - 6, 16);
        } else {
          font(g, 15, true);
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          const cols: [string, number, number, string][] = [
            ['NH', av.nhPct / 110, av.nhPct, '#46f070'],
            ['FTIT', (av.ftitC - 200) / 900, av.ftitC, av.ftitC > 900 ? '#ffa326' : '#46f070'],
            ['NOZ', av.nozzlePct / 100, av.nozzlePct, '#46f070'],
            ['FUEL', av.totalFuelKg / 3500, av.totalFuelKg, av.warnings & 8 ? '#ffa326' : '#46f070'],
          ];
          cols.forEach(([name, fr, v, col], i) => {
            const x = 18 + i * 58;
            g.strokeStyle = '#e9f1f4';
            g.lineWidth = 1.5;
            g.strokeRect(x, 40, 34, 160);
            g.fillStyle = col;
            const f = Math.max(0, Math.min(1, fr));
            g.fillRect(x + 2, 198 - 156 * f, 30, 156 * f);
            g.fillStyle = '#e9f1f4';
            g.fillText(name, x + 17, 22);
            g.fillText(String(Math.round(v)), x + 17, 220);
          });
          font(g, 14);
          g.fillStyle = '#46d8f4';
          g.fillText(`FF ${Math.round(av.ffKgH)}`, W / 2, 244);
        }
      });
      screen.setBrightness(0.55 + 0.8 * (1 - ctx.f.night));
    },
    dispose() {
      screen.dispose();
    },
  };
}
