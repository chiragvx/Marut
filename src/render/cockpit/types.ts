/**
 * src/render/cockpit/types.ts — shared shapes for the 3D cockpit.
 *
 * The cockpit is built from generic components (HUD, MFD, UFCP, standby display, stick, throttle,
 * pedals, seat, canopy, switches, panels) that any aircraft can reuse; an aircraft's layout file
 * (layouts/*.ts) places them. Everything is authored in the COCKPIT FRAME: body axes (x forward,
 * y up, z right), metres, origin at the design eye point (DEP). The whole cockpit is one Object3D
 * placed at the DEP in the aircraft body frame.
 */

import type * as THREE from 'three';
import type { QuatLike, SpeedUnit, Vec3Like } from '../../contracts/core';
import type { CockpitAction, CockpitAuxState, CockpitPilotControls } from '../../contracts/render';
import type { Avionics, StoreInventory } from './avionics';

/** The player's aircraft this frame, as the 3D view shows it (interpolated), plus the newest HUD data. */
export interface CockpitFlight {
  valid: boolean;
  /** Sim time the view shows, s. */
  simTimeSec: number;
  /** World position, orientation and velocity (interpolated). */
  pos: Vec3Like;
  rot: QuatLike;
  vel: Vec3Like;
  /** The newest snapshot's HUD block (read with contracts/core SnapshotHud offsets). */
  hud: Float64Array;
  flags: number;
  throttle: number;
  afterburner: boolean;
  gearPos: number;
  elevonL: number;
  elevonR: number;
  rudder: number;
  /** Packed stores (contracts/core.ts STORES / STORES_B). */
  stores: number;
  storesB: number;
  /** The designated target, interpolated like the view (for conformal HUD symbols). */
  targetValid: boolean;
  targetPos: Vec3Like;
  /** World-frame light: direction to the sun (or moon), its colour, sky/ground ambient; night lights 0..1. */
  sunDir: Vec3Like;
  sunCol: { r: number; g: number; b: number };
  ambSky: { r: number; g: number; b: number };
  ambGround: { r: number; g: number; b: number };
  night: number;
}

/** Display pages and switch positions owned by the cockpit itself (not the sim). */
export interface CockpitLocalState {
  /** Page shown on each MFD, by the MFD's id. */
  mfdPage: Record<string, string>;
  /** HUD: 0 = normal, 1 = declutter; brightness 0..1 (auto adds ambient). */
  hudDeclutter: number;
  hudBrightness: number;
  /** Radar display range scale, km. */
  radarRangeKm: number;
  /** Navigation display range, km. */
  hsiRangeKm: number;
  /** Panel (instrument) lighting knob 0..1 and flood light 0..1: used at night. */
  panelLights: number;
  floodLights: number;
  /** UFCP: the selected autopilot bug the arrow keys adjust. */
  ufcpField: 'hdg' | 'alt' | 'spd' | 'vs';
  /** Master caution/warning acknowledged: the warning bits at the time of the press. */
  warnAck: number;
}

/** Everything a component reads each frame. */
export interface CockpitContext {
  f: CockpitFlight;
  av: Avionics;
  controls: CockpitPilotControls;
  aux: CockpitAuxState;
  local: CockpitLocalState;
  /** Current eye position in the cockpit frame (the HUD mask traces rays from it). */
  eye: THREE.Vector3;
  /** Wall time, s; frame step, s. */
  timeSec: number;
  dtSec: number;
  speedUnit: SpeedUnit;
  /** Stores carried (from the snapshot) and gun rounds left (counted from the gun-fire events). */
  inv: StoreInventory;
  gunRounds: number;
  /** Warning bits not yet acknowledged with the master warning/caution light. */
  unackedWarnings: number;
}

/** A clickable control. `target` is the mesh the pointer ray is tested against. */
export interface CockpitControl {
  target: THREE.Object3D;
  /** Tooltip text (name and state). */
  label(ctx: CockpitContext): string;
  /** Pressed: change cockpit state and/or return what the aircraft must do. */
  press(ctx: CockpitContext): CockpitAction | null;
}

/** A cockpit component: its object (placed by the layout), per-frame update and clickable controls. */
export interface CockpitComponent {
  object: THREE.Object3D;
  update?(ctx: CockpitContext): void;
  controls?: CockpitControl[];
  dispose?(): void;
}
