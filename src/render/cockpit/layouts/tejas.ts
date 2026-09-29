/**
 * src/render/cockpit/layouts/tejas.ts — the HAL Tejas Mk1A cockpit.
 *
 * Arrangement from photographs of the Tejas Mk1/Mk1A cockpit (ADA/HAL, CSIO HUD, BEL displays):
 * - CSIO head-up display on top of the centre, 24 deg total field of view, a tall single combiner
 *   in a black frame with lightening-hole side plates; the up-front control panel (12-key keypad
 *   and a yellow-green LCD) on the HUD's face below it.
 * - Three 5 x 5 in colour MFDs (square OSBs top and bottom, round OSBs on the sides): left and
 *   right on the light-grey "wing" panels, the centre one low between the knees under the UFCP.
 * - Two Smart Standby Display Units, one above each side MFD (left: standby attitude with speed and
 *   altitude tapes; right: engine data), under a row of square push buttons with the master
 *   warning (left) and master caution (right) lights.
 * - Annunciator strips outboard of the side MFDs; hazard-striped guarded switches on the left.
 * - Centre stick, throttle on the left console, Martin-Baker Mk16 seat, bubble canopy behind a
 *   windscreen arch with a standby compass on it.
 *
 * Where no public detail exists (console panels, exact legends, where the gear handle is) the
 * layout follows common fighter practice: gear handle low on the left, lighting and oxygen on the
 * right console, fuel and radio on the left, and so on.
 *
 * Cockpit frame: origin at the design eye point: station 4.02 m, 1.07 m above the radome tip, on
 * the exterior model (tejasModel.ts), i.e. body (3.53, 0.84): 0.26 m under the canopy's apex and
 * 0.3 m above its rail, 0.6 m behind the windscreen arch.
 */

import * as THREE from 'three';
import { LIGHT_MODES } from '../../../contracts/core';
import { CANOPY_FRONT_X, canopyProfile } from '../../aircraftModels/tejasModel';
import { apEngaged, atEngaged } from '../avionics';
import { box, facing, local, mul, oriented } from '../build';
import type { CockpitKit, CockpitLayout } from '../index';
import { CanvasScreen, font } from '../screen';
import type { CockpitComponent, CockpitContext } from '../types';
import { LAMP, lamp, pushButton, rotaryKnob, toggleSwitch } from '../components/controls';
import { createPedals, createStick, createThrottle } from '../components/flightControls';
import { createHud } from '../components/hud';
import { createMfd } from '../components/mfd';
import type { MfdConfig } from '../components/mfdPages';
import { addPanel, rectOutline } from '../components/panel';
import { createSeat, createStandbyCompass } from '../components/seat';
import { createSsdu } from '../components/ssdu';
import { buildShell, type CanopySection } from '../components/structure';
import { createUfcp } from '../components/ufcp';

/** Design eye point, exterior layout frame. */
const DEP_X = 3.53;
const DEP_Y = 0.84;

const canopyAt = (x: number): CanopySection => {
  const p = canopyProfile(Math.min(CANOPY_FRONT_X, x + DEP_X));
  return { sillY: p.sillY - DEP_Y, topY: p.topY - DEP_Y, halfW: p.halfW, n: p.n };
};

const EYE = new THREE.Vector3(0, 0, 0);
const DEG = Math.PI / 180;
const INK = '#15171a';
const WHITE = '#ecece6';

/** Tejas data for the displays (tejasGeometry.ts: 2458 kg internal fuel, +8/-3 g, 22 deg AoA; bingo from the RMFD photo). */
const MFD_CONFIG: MfdConfig = {
  planform: [
    [7.2, 0],
    [5.2, 0.42],
    [2.6, 0.62],
    [0.4, 0.66],
    [-3.3, 4.1],
    [-4.3, 4.1],
    [-4.7, 0.62],
    [-6.2, 0.46],
    [-6.2, -0.46],
    [-4.7, -0.62],
    [-4.3, -4.1],
    [-3.3, -4.1],
    [0.4, -0.66],
    [2.6, -0.62],
    [5.2, -0.42],
  ],
  // Snapshot slots (tejasGeometry.ts station order minus the gun), numbered 1..7 left to right, 8 the pod.
  stations: [
    { slot: 0, label: '1', x: -3.2, z: -3.3 },
    { slot: 2, label: '2', x: -2.6, z: -2.5 },
    { slot: 4, label: '3', x: -1.8, z: -1.8 },
    { slot: 6, label: '4', x: 0.3, z: 0 },
    { slot: 5, label: '5', x: -1.8, z: 1.8 },
    { slot: 3, label: '6', x: -2.6, z: 2.5 },
    { slot: 1, label: '7', x: -3.2, z: 3.3 },
  ],
  internalFuelKg: 2458,
  bingoKg: 800,
  gMax: 8,
  gMin: -3,
  aoaMaxDeg: 22,
};

const lightIndex = (c: CockpitContext): number => Math.max(0, LIGHT_MODES.findIndex((m) => m.name === c.aux.lightMode));
const blink = (c: CockpitContext, hz = 2): number => (Math.floor(c.timeSec * hz * 2) % 2 === 0 ? 1 : 0.15);

export const TEJAS_COCKPIT: CockpitLayout = {
  name: 'Tejas Mk1A',
  eyeBody: new THREE.Vector3(DEP_X, DEP_Y, 0),
  mfdPages: { L: 'SNSR', C: 'ENG', R: 'HSI' },
  build(kit: CockpitKit): CockpitComponent[] {
    const out: CockpitComponent[] = [];
    const { mats, batch, glassU } = kit;
    const add = (c: CockpitComponent): void => void out.push(c);

    // --- Shell and canopy. ---
    const shell = {
      canopy: canopyAt,
      railY: -0.3,
      floorY: -1.1,
      rearX: -0.62,
      frontX: 1.15,
      consoleTopY: -0.62,
      consoleInnerZ: 0.27,
      consoleFrontX: 0.36,
      consoleRearX: -0.55,
      panelX: 0.66,
      panelTopY: -0.2,
      panelBottomY: -0.64,
      coamingEndX: 1.75,
      coamingEndY: -0.43,
      coamingLipHalfWidth: 0.11,
      canopyRearX: -0.86,
      archX: 0.62,
      windscreenEndX: CANOPY_FRONT_X - DEP_X - 0.01,
      fairingEndX: -1.6,
    };
    add(buildShell(shell, mats, batch, glassU));

    // --- Head-up display and the UFCP on its face. ---
    add(
      createHud(
        {
          combinerCenter: new THREE.Vector3(0.53, -0.07, 0),
          combinerW: 0.19,
          combinerH: 0.21,
          combinerLean: 0.5,
          bodyW: 0.18,
          bodyH: 0.14,
          bodyDepth: 0.34,
          axisElevationRad: -6.5 * DEG,
          tfovDeg: 24,
        },
        mats,
        batch,
        glassU
      )
    );
    add(createUfcp(kit, facing(new THREE.Vector3(0.54, -0.245, 0), EYE, 0.12), { w: 0.18, h: 0.11 }));

    // --- Centre column: centre MFD between the knees. ---
    const centre = facing(new THREE.Vector3(0.64, -0.45, 0), EYE, 0.05);
    addPanel(kit, centre, {
      outline: rectOutline(0, -0.02, 0.21, 0.34),
      fasteners: 4,
      pxPerMm: 1.8,
      paint: (p, at) => {
        const [x, y] = at(0, -0.175);
        p.text('LCA TEJAS', x, y, 4.6, { color: INK, bold: true });
      },
    });
    add(createMfd(kit, centre, { id: 'C', screen: 0.127, config: MFD_CONFIG }));

    // --- Wing panels: side MFD, SSDU, push-button row with the master light, annunciators. ---
    for (const side of [-1, 1]) {
      const L = side < 0;
      const frame = facing(new THREE.Vector3(0.7, -0.3, side * 0.245), EYE, 0.08);
      const mx = (x: number): number => x * -side; // local x as authored for the left panel
      const outline: [number, number][] = (
        [
          [-0.15, -0.19],
          [0.125, -0.19],
          [0.125, 0.215],
          [-0.02, 0.215],
          [-0.15, 0.1],
        ] as [number, number][]
      ).map(([x, y]) => [mx(x), y]);
      if (!L) outline.reverse();
      addPanel(kit, frame, {
        outline,
        fasteners: 4,
        pxPerMm: 1.8,
        paint: (p, at) => {
          if (L) {
            // Hazard stripes round the guarded switches, as on the Tejas's left panel.
            const [sx, sy] = at(-0.135, 0.118);
            p.stripes(sx, sy, 58, 5, 3);
            const [a, b] = at(-0.113, 0.104);
            p.text('MASTER ARM', a, b, 3.8, { color: INK, bold: true });
            const [c, d] = at(-0.058, 0.104);
            p.text('EMER JETT', c, d, 3.8, { color: INK, bold: true });
            const [g, h] = at(-0.03, 0.155);
            p.text('HUD', g, h, 3.8, { color: INK, bold: true });
          } else {
            const [a, b] = at(mx(-0.078), 0.152);
            p.text('CLOCK', a, b, 3.8, { color: INK, bold: true });
          }
          const [lx, ly] = at(mx(-0.115), 0.055);
          p.text(L ? 'CWP' : 'RWR', lx, ly, 3.8, { color: INK, bold: true });
          const [tx, ty] = at(mx(0.02), -0.172);
          p.text(L ? 'LMFD' : 'RMFD', tx, ty, 4.1, { color: INK, bold: true });
        },
      });
      add(createMfd(kit, frame, { id: L ? 'L' : 'R', screen: 0.127, config: MFD_CONFIG }));
      add(createSsdu(kit, mul(frame, local(mx(0.045), 0.125, 0)), { screen: 0.066, kind: L ? 'attitude' : 'engine' }));

      // Push-button row over the SSDU, then the master light.
      const row: [string[], (c: CockpitContext) => string, (c: CockpitContext) => import('../../../contracts/render').CockpitAction | null, ((c: CockpitContext) => number)?][] = L
        ? [
            [['DCLT'], (c) => `HUD declutter: ${c.local.hudDeclutter ? 'ON' : 'off'}`, (c) => ((c.local.hudDeclutter = c.local.hudDeclutter ? 0 : 1), null), (c) => c.local.hudDeclutter],
            [['AP'], (c) => `Autopilot: ${apEngaged(c.av) ? 'ENGAGED' : 'off'}`, () => ({ kind: 'autopilot', action: { type: 'toggleAp' } }), (c) => (apEngaged(c.av) ? 1 : 0)],
            [['A/T'], (c) => `Autothrottle: ${atEngaged(c.av) ? 'ENGAGED' : 'off'}`, () => ({ kind: 'autopilot', action: { type: 'toggleAt' } }), (c) => (atEngaged(c.av) ? 1 : 0)],
            [['TAXI'], () => 'Taxi guidance (on the ground)', () => ({ kind: 'taxiGuide' })],
          ]
        : [
            [['WPN', 'SEL'], () => 'Weapon select (cycle weapon)', () => ({ kind: 'cycleWeapon' })],
            [['TGT'], () => 'Target designate (cycle target)', () => ({ kind: 'cycleTarget' })],
            [['ACM'], (c) => `Radar: ${c.av.radarMode === 1 ? 'ACM' : 'RWS'} (press to toggle)`, () => ({ kind: 'radarMode' }), (c) => (c.av.radarMode === 1 ? 1 : 0)],
            [['LTS'], (c) => `Exterior lights: ${c.aux.lightMode} (L)`, () => ({ kind: 'lights' })],
          ];
      row.forEach(([legend, label, press, lit], i) => {
        add(
          pushButton(kit, frame, {
            x: mx(-0.005 + i * 0.022),
            y: 0.196,
            w: 0.017,
            h: 0.014,
            legend,
            label,
            press,
            ...(lit ? { lit: { color: LAMP.green, get: lit } } : {}),
          })
        );
      });
      // Master warning (left, red) / master caution (right, amber): flash until pressed.
      const warnMask = L ? 0x1c7 /* pull up, fire, launch, stall, overspeed, over G */ : 0x238 /* lock, fuel, gear, config */;
      add(
        pushButton(kit, frame, {
          x: mx(0.095),
          y: 0.196,
          w: 0.026,
          h: 0.016,
          legend: L ? ['MASTER', 'WARN'] : ['MASTER', 'CAUT'],
          cap: '#2a1512',
          lit: { color: L ? LAMP.red : LAMP.amber, get: (c) => ((c.unackedWarnings & warnMask) !== 0 ? blink(c, 2) : 0) },
          label: (c) => `Master ${L ? 'warning' : 'caution'}${(c.unackedWarnings & warnMask) !== 0 ? ' (press to acknowledge)' : ''}`,
          press: (c) => ((c.local.warnAck |= c.av.warnings & warnMask), null),
        })
      );
      // Annunciators outboard of the MFD.
      const lamps: [string[], THREE.Color, (c: CockpitContext) => number][] = L
        ? [
            [['ENG', 'FIRE'], LAMP.red, (c) => (c.av.warnings & 256 ? blink(c, 3) : 0)],
            [['PULL', 'UP'], LAMP.red, (c) => (c.av.warnings & 128 ? blink(c, 4) : 0)],
            [['FUEL', 'LOW'], LAMP.amber, (c) => (c.av.warnings & 8 ? 1 : 0)],
          ]
        : [
            [['LAUNCH'], LAMP.red, (c) => (c.av.warnings & 64 ? blink(c, 3) : 0)],
            [['LOCK'], LAMP.amber, (c) => (c.av.warnings & 32 ? 1 : 0)],
            [['AOA'], LAMP.amber, (c) => (c.av.warnings & 1 ? 1 : 0)],
          ];
      lamps.forEach(([legend, color, get], i) => add(lamp(kit, frame, { x: mx(-0.117), y: 0.022 - i * 0.042, w: 0.03, h: 0.032, legend, color, get })));

      if (L) {
        // Master arm (red guard) and emergency jettison (striped guard).
        add(
          toggleSwitch(kit, frame, {
            x: -0.113,
            y: 0.075,
            positions: 2,
            guard: 'red',
            get: (c) => (c.aux.masterArm ? 1 : 0),
            label: (c) => `Master arm: ${c.aux.masterArm ? 'ARM' : 'SAFE'}`,
            press: () => ({ kind: 'masterArm' }),
          })
        );
        add(
          toggleSwitch(kit, frame, {
            x: -0.058,
            y: 0.075,
            positions: 2,
            guard: 'stripes',
            get: () => 0,
            label: (c) => (c.av.tankKg >= 0 ? 'Emergency jettison: drop tanks (J)' : 'Emergency jettison (no tanks)'),
            press: () => ({ kind: 'jettison' }),
          })
        );
        // HUD brightness.
        const levels = [0.45, 0.7, 1, 1.35];
        add(
          rotaryKnob(kit, frame, {
            x: -0.052,
            y: 0.155,
            radius: 0.008,
            detents: [-1.6, -0.55, 0.55, 1.6],
            get: (c) => Math.max(0, levels.indexOf(c.local.hudBrightness)),
            label: (c) => `HUD brightness: ${Math.round(c.local.hudBrightness * 100)} %`,
            press: (c) => ((c.local.hudBrightness = levels[(Math.max(0, levels.indexOf(c.local.hudBrightness)) + 1) % levels.length]!), null),
          })
        );
      } else {
        add(createClock(kit, mul(frame, local(mx(-0.078), 0.108, 0.004))));
      }
    }

    // --- Knee panels: gear on the left, brakes/hook and the clock's stopwatch on the right. ---
    for (const side of [-1, 1]) {
      const L = side < 0;
      const frame = facing(new THREE.Vector3(0.65, -0.555, side * 0.235), EYE, 0.3);
      addPanel(kit, frame, {
        outline: rectOutline(0, 0, 0.2, 0.11),
        color: '#8a8f91',
        fasteners: 4,
        paint: (p, at) => {
          if (L) {
            const [a, b] = at(-0.052, 0.045);
            p.text('LDG GEAR', a, b, 4.1, { color: INK, bold: true });
            const [c, d] = at(0.045, 0.045);
            p.text('GEAR POS', c, d, 3.8, { color: INK, bold: true });
            const [e, f] = at(-0.052, -0.047);
            p.text('UP  /  DN', e, f, 3.5, { color: INK });
          } else {
            const [a, b] = at(0, 0.045);
            p.text('BRAKES / SPD BRK', a, b, 3.8, { color: INK, bold: true });
          }
        },
      });
      if (L) {
        add(createGearHandle(kit, frame));
        const gl = (x: number, y: number, t: string): void =>
          add(
            lamp(kit, frame, {
              x,
              y,
              w: 0.018,
              h: 0.015,
              legend: [t],
              color: LAMP.green,
              get: (c) => (c.av.gearPos > 0.98 ? 1 : 0),
            })
          );
        gl(0.045, 0.02, 'NOSE');
        gl(0.024, -0.002, 'LEFT');
        gl(0.066, -0.002, 'RIGHT');
        add(
          lamp(kit, frame, {
            x: 0.045,
            y: -0.028,
            w: 0.03,
            h: 0.014,
            legend: ['GEAR'],
            color: LAMP.red,
            get: (c) => (c.av.gearPos > 0.02 && c.av.gearPos < 0.98 ? 1 : c.av.warnings & 16 ? blink(c, 2) : 0),
          })
        );
      } else {
        add(
          lamp(kit, frame, { x: -0.05, y: 0.005, w: 0.036, h: 0.022, legend: ['SPD', 'BRK'], color: LAMP.green, get: (c) => (c.av.airbrake ? 1 : 0), label: (c) => `Speed brake: ${c.av.airbrake ? 'OUT' : 'IN'}`, press: () => ({ kind: 'airbrake' }) })
        );
        add(lamp(kit, frame, { x: 0.0, y: 0.005, w: 0.036, h: 0.022, legend: ['WHEEL', 'BRK'], color: LAMP.amber, get: (c) => (c.controls.brakes > 0.05 && c.av.onGround ? 1 : 0) }));
        add(lamp(kit, frame, { x: 0.05, y: 0.005, w: 0.036, h: 0.022, legend: ['NWS'], color: LAMP.green, get: (c) => (c.av.onGround ? 1 : 0) }));
      }
    }

    // --- Consoles. ---
    const consoleFrame = (x: number, z: number): THREE.Matrix4 => oriented(new THREE.Vector3(x, shell.consoleTopY + 0.002, z), { x: 0, y: 1, z: 0 });
    const blackPanel = { color: '#1c1e20', fasteners: 3.5, wear: 1 };
    // Left: exterior lights, the throttle quadrant with the engine panel beside it, fuel, radio.
    {
      const f = consoleFrame(0.27, -0.34);
      addPanel(kit, f, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.13, 0.15),
        paint: (p, at) => {
          const [a, b] = at(0, 0.062);
          p.text('EXT LIGHTS', a, b, 4.6, { color: WHITE, bold: true });
          LIGHT_MODES.forEach((m, i) => {
            const ang = -1.6 + (3.2 * i) / (LIGHT_MODES.length - 1);
            const [x, y] = at(-0.025 + Math.sin(ang) * 0.028, 0.0 + Math.cos(ang) * 0.028);
            p.text(m.name.toUpperCase().replace('NAV + ', 'N+').slice(0, 7), x, y, 2.9, { color: WHITE });
          });
          const [c, d] = at(0.04, 0.032);
          p.text('ANTI-COLL', c, d, 3.2, { color: WHITE });
          const [e, g] = at(0.04, -0.042);
          p.text('LDG/TAXI', e, g, 3.2, { color: WHITE });
        },
      });
      add(
        rotaryKnob(kit, f, {
          x: -0.025,
          y: 0,
          radius: 0.011,
          detents: LIGHT_MODES.map((_, i) => -1.6 + (3.2 * i) / (LIGHT_MODES.length - 1)),
          get: lightIndex,
          label: (c) => `Exterior lights: ${c.aux.lightMode} (L)`,
          press: () => ({ kind: 'lights' }),
        })
      );
      add(toggleSwitch(kit, f, { x: 0.04, y: 0.012, positions: 2, get: (c) => (LIGHT_MODES[lightIndex(c)]!.flags & 32 ? 1 : 0), label: (c) => `Anti-collision strobes (set by the lights mode: ${c.aux.lightMode})`, press: () => ({ kind: 'lights' }) }));
      add(toggleSwitch(kit, f, { x: 0.04, y: -0.022, positions: 2, get: (c) => (LIGHT_MODES[lightIndex(c)]!.flags & 64 ? 1 : 0), label: (c) => `Landing/taxi light (set by the lights mode: ${c.aux.lightMode})`, press: () => ({ kind: 'lights' }) }));
    }
    {
      // Throttle quadrant: a slotted plate inboard, the engine panel outboard.
      const f = consoleFrame(0.03, -0.302);
      addPanel(kit, f, {
        color: '#2a2c2e',
        fasteners: 0,
        wear: 1,
        outline: rectOutline(0, 0, 0.06, 0.3),
        paint: (p, at) => {
          const [sx, sy] = at(-0.004, 0.13);
          p.rect(sx, sy, 8, 250, '#050505');
          for (const [t, y] of [
            ['IDLE', -0.085],
            ['MIL', 0.045],
            ['A/B', 0.105],
          ] as const) {
            const [x, yy] = at(0.018, y);
            p.text(t, x, yy, 3.8, { color: WHITE, bold: true, rotate: -Math.PI / 2 });
          }
          const [a, b] = at(-0.02, 0.075);
          p.stripes(a, b, 7, 4, 2);
        },
      });
      add(createThrottle(kit, { pivot: new THREE.Vector3(0.03, shell.consoleTopY - 0.07, -0.302), length: 0.14, idleRad: -24 * DEG, milRad: 8 * DEG, abRad: 22 * DEG }));
      const e = consoleFrame(0.03, -0.37);
      addPanel(kit, e, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.07, 0.3),
        paint: (p, at) => {
          const lines: [string, number][] = [
            ['ENGINE', 0.13],
            ['ENG MASTER', 0.09],
            ['JFS', 0.035],
            ['FUEL PUMP', -0.02],
            ['ANTI-ICE', -0.075],
            ['REFUEL', -0.12],
          ];
          for (const [t, y] of lines) {
            const [x, yy] = at(0, y);
            p.text(t, x, yy, t === 'ENGINE' ? 3 : 2.3, { color: WHITE, bold: t === 'ENGINE' });
          }
        },
      });
      const on = (): number => 1;
      add(toggleSwitch(kit, e, { x: 0, y: 0.07, positions: 2, guard: 'red', get: on, label: () => 'Engine master: ON', press: () => null }));
      add(toggleSwitch(kit, e, { x: 0, y: 0.015, positions: 3, get: () => 1, label: () => 'Jet fuel starter: OFF (engine running)', press: () => null }));
      add(toggleSwitch(kit, e, { x: 0, y: -0.04, positions: 2, get: on, label: () => 'Fuel boost pumps: ON', press: () => null }));
      add(toggleSwitch(kit, e, { x: 0, y: -0.095, positions: 2, get: () => 0, label: () => 'Engine anti-ice: OFF', press: () => null }));
      add(
        pushButton(kit, e, {
          x: 0,
          y: -0.137,
          w: 0.03,
          h: 0.014,
          legend: ['GND SVC'],
          label: () => 'Ground refuel and rearm (stopped on a friendly stand)',
          press: () => ({ kind: 'service' }),
        })
      );
    }
    {
      const f = consoleFrame(-0.21, -0.34);
      addPanel(kit, f, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.13, 0.16),
        paint: (p, at) => {
          const [a, b] = at(0, 0.066);
          p.text('FUEL', a, b, 4.6, { color: WHITE, bold: true });
          const [c, d] = at(-0.032, 0.03);
          p.text('TANK JETT', c, d, 3.2, { color: WHITE });
          const [e, g] = at(0.035, 0.03);
          p.text('XFER', e, g, 3.2, { color: WHITE });
          const [h, i] = at(0, -0.045);
          p.rect(h - 26, i - 5, 52, 11, '#070707');
          p.text('BINGO 0800', h, i, 4.9, { color: '#ff3b20', bold: true });
        },
      });
      add(toggleSwitch(kit, f, { x: -0.032, y: 0.005, positions: 2, guard: 'stripes', get: () => 0, label: (c) => (c.av.tankKg >= 0 ? 'Drop tank jettison (J)' : 'Drop tank jettison (no tanks)'), press: () => ({ kind: 'jettison' }) }));
      add(toggleSwitch(kit, f, { x: 0.035, y: 0.005, positions: 2, get: (c) => (c.av.tankKg > 0 ? 1 : 0), label: (c) => `External fuel transfer: ${c.av.tankKg > 0 ? 'ON' : 'OFF'}`, press: () => null }));
    }
    {
      const f = consoleFrame(-0.42, -0.34);
      addPanel(kit, f, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.13, 0.2),
        paint: (p, at) => {
          const [a, b] = at(0, 0.085);
          p.text('V/UHF 1', a, b, 4.6, { color: WHITE, bold: true });
          const [c, d] = at(0, 0.045);
          p.rect(c - 30, d - 7, 60, 14, '#070707');
          p.text('251.000', c, d, 7.2, { color: '#ff3b20', bold: true });
          const [e, g] = at(-0.03, -0.03);
          p.text('VOL', e, g + 12, 3.2, { color: WHITE });
          const [h, i] = at(0.03, -0.03);
          p.text('CHAN', h, i + 12, 3.2, { color: WHITE });
        },
      });
      for (const x of [-0.03, 0.03]) add(rotaryKnob(kit, f, { x, y: -0.015, radius: 0.009, detents: [0.6], get: () => 0, label: () => (x < 0 ? 'Radio volume' : 'Radio channel'), press: () => null }));
    }
    // Right: interior lights, IFF/navigation, oxygen, environment.
    {
      const f = consoleFrame(0.27, 0.34);
      addPanel(kit, f, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.13, 0.15),
        paint: (p, at) => {
          const [a, b] = at(0, 0.062);
          p.text('INT LIGHTS', a, b, 4.6, { color: WHITE, bold: true });
          const [c, d] = at(-0.03, -0.035);
          p.text('PANEL', c, d, 3.5, { color: WHITE });
          const [e, g] = at(0.03, -0.035);
          p.text('FLOOD', e, g, 3.5, { color: WHITE });
        },
      });
      const lv = [0, 0.35, 0.7, 1];
      const idx = (v: number): number => lv.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(lv[best]! - v) ? i : best), 0);
      add(rotaryKnob(kit, f, { x: -0.03, y: 0.005, radius: 0.01, detents: [-1.8, -0.6, 0.6, 1.8], get: (c) => idx(c.local.panelLights), label: (c) => `Instrument lights: ${Math.round(c.local.panelLights * 100)} % (at night)`, press: (c) => ((c.local.panelLights = lv[(idx(c.local.panelLights) + 1) % 4]!), null) }));
      add(rotaryKnob(kit, f, { x: 0.03, y: 0.005, radius: 0.01, detents: [-1.8, -0.6, 0.6, 1.8], get: (c) => idx(c.local.floodLights), label: (c) => `Flood lights: ${Math.round(c.local.floodLights * 100)} % (at night)`, press: (c) => ((c.local.floodLights = lv[(idx(c.local.floodLights) + 1) % 4]!), null) }));
    }
    {
      const f = consoleFrame(0.1, 0.34);
      addPanel(kit, f, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.13, 0.17),
        paint: (p, at) => {
          const [a, b] = at(0, 0.07);
          p.text('IFF', a, b, 4.6, { color: WHITE, bold: true });
          const [c, d] = at(0, 0.038);
          p.rect(c - 22, d - 7, 44, 14, '#070707');
          p.text('M3 1200', c, d, 6.1, { color: '#ff3b20', bold: true });
          const [e, g] = at(0, -0.02);
          p.text('TACAN', e, g, 4.3, { color: WHITE, bold: true });
          const [h, i] = at(0, -0.05);
          p.rect(h - 22, i - 7, 44, 14, '#070707');
          p.text('047X', h, i, 6.1, { color: '#ff3b20', bold: true });
        },
      });
    }
    {
      const f = consoleFrame(-0.1, 0.34);
      addPanel(kit, f, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.13, 0.17),
        paint: (p, at) => {
          const [a, b] = at(0, 0.07);
          p.text('OXYGEN', a, b, 4.6, { color: WHITE, bold: true });
          const [c, d] = at(-0.035, -0.045);
          p.text('SUPPLY', c, d, 3.2, { color: WHITE });
          const [e, g] = at(0.035, -0.045);
          p.text('100 %', e, g, 3.2, { color: WHITE });
          const [h, i] = at(0.025, 0.035);
          p.text('FLOW', h, i, 3.2, { color: WHITE });
        },
      });
      // Flow blinker: white on each breath (every ~4 s).
      add(lamp(kit, f, { x: -0.02, y: 0.03, w: 0.022, h: 0.016, legend: [''], color: LAMP.white, get: (c) => (c.timeSec % 4.2 < 1.6 ? 0.8 : 0), label: () => 'Oxygen flow indicator (blinks with each breath)', press: () => null }));
      add(toggleSwitch(kit, f, { x: -0.035, y: -0.018, positions: 2, get: () => 1, label: () => 'Oxygen supply: ON', press: () => null }));
      add(toggleSwitch(kit, f, { x: 0.035, y: -0.018, positions: 2, get: () => 0, label: () => 'Oxygen: NORMAL', press: () => null }));
    }
    {
      const f = consoleFrame(-0.36, 0.34);
      addPanel(kit, f, {
        ...blackPanel,
        outline: rectOutline(0, 0, 0.13, 0.24),
        paint: (p, at) => {
          const [a, b] = at(0, 0.105);
          p.text('ECS', a, b, 4.6, { color: WHITE, bold: true });
          const [c, d] = at(-0.03, 0.03);
          p.text('TEMP', c, d + 14, 3.2, { color: WHITE });
          const [e, g] = at(0.03, 0.03);
          p.text('DEFOG', e, g + 14, 3.2, { color: WHITE });
          const [h, i] = at(0, -0.07);
          p.text('CANOPY SEAL', h, i, 3.2, { color: WHITE });
        },
      });
      add(rotaryKnob(kit, f, { x: -0.03, y: 0.045, radius: 0.009, detents: [0.3], get: () => 0, label: () => 'Cockpit temperature: AUTO', press: () => null }));
      add(toggleSwitch(kit, f, { x: 0.03, y: 0.045, positions: 2, get: () => 0, label: () => 'Windscreen defog: OFF', press: () => null }));
      add(toggleSwitch(kit, f, { x: 0, y: -0.05, positions: 2, get: () => 1, label: () => 'Canopy seal: ON', press: () => null }));
    }

    // --- Stick, pedals, seat. ---
    add(createStick(kit, { pivot: new THREE.Vector3(0.36, -1.02, 0), length: 0.58, maxPitchRad: 13 * DEG, maxRollRad: 11 * DEG }));
    add(createPedals(kit, { centre: new THREE.Vector3(0.98, -0.95, 0), spacing: 0.135, travel: 0.035 }));
    add(createSeat(kit, { panFront: new THREE.Vector3(0.12, -0.8, 0), backAngle: 17 * DEG, width: 0.46 }));

    // --- Standby compass on the windscreen arch, right of the HUD. ---
    add(createStandbyCompass(kit, facing(new THREE.Vector3(0.84, 0.035, 0.2), EYE)));

    // Side rails of the canopy frame get some small hardware: canopy handles and mirrors mounts.
    batch.add(box(0.12, 0.02, 0.02), mats.yellow, local(-0.2, shell.railY + 0.02, -0.4));
    batch.add(box(0.03, 0.03, 0.02), mats.rubber, local(-0.14, shell.railY + 0.03, -0.4));

    return out;
  },
};

/** The landing gear handle: a lever with a wheel-shaped knob that lights red while the gear is moving. */
function createGearHandle(kit: CockpitKit, frame: THREE.Matrix4): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  // The handle slides in a vertical slot: up for gear up, down for gear down.
  const pivot = new THREE.Group();
  pivot.position.set(-0.052, 0, 0.004);
  object.add(pivot);
  pivot.add(new THREE.Mesh(box(0.007, 0.012, 0.03).translate(0, 0, 0.015), kit.mats.metal));
  // Wheel knob (white, with a red light inside that glows while the gear travels).
  const knobMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.5, emissive: 0x000000 });
  knobMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <colorspace_fragment>', 'gl_FragColor = sRGBTransferOETF( gl_FragColor );');
  };
  knobMat.customProgramCacheKey = () => 'cockpit-display-out';
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.011, 20).rotateX(Math.PI / 2), knobMat);
  wheel.position.set(0, 0, 0.034);
  pivot.add(wheel);
  // Slot in the panel.
  kit.batch.add(box(0.012, 0.075, 0.002), kit.mats.rubber, mul(frame, local(-0.052, 0.0, 0.001)));
  let y = 0.025;
  return {
    object,
    controls: [
      {
        target: pivot,
        label: (c) => `Landing gear: ${c.av.gearDownCmd ? 'DOWN' : 'UP'}${c.av.gearPos > 0.02 && c.av.gearPos < 0.98 ? ' (in transit)' : ''} (G)`,
        press: () => ({ kind: 'gear' }),
      },
    ],
    update(ctx) {
      const target = ctx.av.gearDownCmd ? -0.026 : 0.026;
      y += (target - y) * Math.min(1, ctx.dtSec * 14);
      pivot.position.y = y;
      const transit = ctx.av.gearPos > 0.02 && ctx.av.gearPos < 0.98;
      knobMat.emissive.setRGB(transit ? 0.6 : 0, 0, 0);
    },
    dispose() {
      knobMat.dispose();
    },
  };
}

/** A clock: time since the flight started (the stopwatch the pilot starts at take-off). */
function createClock(kit: CockpitKit, frame: THREE.Matrix4): CockpitComponent {
  const object = new THREE.Group();
  object.matrixAutoUpdate = false;
  object.matrix.copy(frame);
  kit.batch.add(new THREE.CylinderGeometry(0.03, 0.031, 0.02, 28).rotateX(Math.PI / 2).translate(0, 0, 0.004), kit.mats.bezel, frame);
  const screen = new CanvasScreen(0.05, 0.05, 160, 160, 4);
  screen.mesh.position.z = 0.0145;
  object.add(screen.mesh);
  return {
    object,
    update(ctx) {
      screen.refresh(ctx.timeSec, (g, W, H) => {
        const t = Math.max(0, ctx.f.simTimeSec);
        g.fillStyle = '#0c0c0c';
        g.fillRect(0, 0, W, H);
        const cx = W / 2;
        const cy = H / 2;
        g.strokeStyle = '#e8e8e0';
        g.fillStyle = '#e8e8e0';
        for (let i = 0; i < 60; i++) {
          const a = (i / 60) * Math.PI * 2;
          const r0 = i % 5 === 0 ? 62 : 68;
          g.lineWidth = i % 5 === 0 ? 3 : 1;
          g.beginPath();
          g.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
          g.lineTo(cx + Math.sin(a) * 74, cy - Math.cos(a) * 74);
          g.stroke();
        }
        font(g, 16, true);
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        for (let i = 1; i <= 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          g.fillText(String(i), cx + Math.sin(a) * 50, cy - Math.cos(a) * 50);
        }
        const hand = (frac: number, len: number, w: number, col: string): void => {
          g.strokeStyle = col;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(cx, cy);
          g.lineTo(cx + Math.sin(frac * Math.PI * 2) * len, cy - Math.cos(frac * Math.PI * 2) * len);
          g.stroke();
        };
        hand(t / 43200, 36, 5, '#e8e8e0');
        hand((t / 3600) % 1, 54, 3.5, '#e8e8e0');
        hand((t / 60) % 1, 64, 1.5, '#ff5030');
        font(g, 11);
        g.fillText('ET', cx, cy + 26);
      });
      screen.setBrightness(0.5 + 0.2 * (1 - ctx.f.night));
    },
    dispose() {
      screen.dispose();
    },
  };
}
