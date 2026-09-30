/**
 * src/aircraft/aggressors.ts — the hostile aircraft types: the PAF's JF-17 Thunder (Block II/III
 * fits) and F-16 (Block 52 fits). Each has its own weapon fits, radar, countermeasures and radar
 * signature; the airframe (flight model, gear, 3D model) is the Tejas's until these types get their
 * own, so they fly like a Tejas and are drawn as the grey hostile Tejas. Swap `aero`/`engine`/
 * geometry here when a real model exists; nothing else needs to change.
 *
 * Stations reuse the Tejas pylon positions (the render model hangs stores there): outboard = the
 * wingtip-rail missiles, middle = BVR missiles, inboard = tanks or BVR missiles, centreline = tank.
 */
import type { AircraftDefinition, LoadoutPreset, StationDef } from '../contracts/aircraft';
import { tejasDefinition } from './tejasDefinition';
import { hardpointsFor } from './tejasGeometry';

function station(id: string, accepts: string[], maxCount: number): StationDef {
  const base = tejasDefinition.stations!.find((s) => s.id === id)!;
  return { id, posBodyM: base.posBodyM, accepts, maxCount };
}

// --- JF-17 Thunder: 23 mm GSh-23 (as the Tejas), PL-5E II on the wingtip rails, SD-10A or PL-15E
// under the wings, 800/1100 L tanks (modelled as the Tejas tanks). KLJ-7A AESA on Block III.
const jf17Stations: readonly StationDef[] = [
  station('gun', ['gsh-23'], 220),
  station('wing-outer-l', ['pl-5e'], 1),
  station('wing-outer-r', ['pl-5e'], 1),
  station('wing-mid-l', ['sd-10a', 'pl-15e', 'pl-5e'], 1),
  station('wing-mid-r', ['sd-10a', 'pl-15e', 'pl-5e'], 1),
  station('wing-inner-l', ['tank-1200l', 'sd-10a', 'pl-15e'], 1),
  station('wing-inner-r', ['tank-1200l', 'sd-10a', 'pl-15e'], 1),
  station('centreline', ['tank-725l'], 1),
];
const jf17Loadouts: readonly LoadoutPreset[] = [
  {
    id: 'bvr',
    name: 'Air defence: 2x PL-5E II, 2x SD-10A, 2x tanks',
    fit: {
      gun: { store: 'gsh-23', count: 220 },
      'wing-outer-l': { store: 'pl-5e', count: 1 },
      'wing-outer-r': { store: 'pl-5e', count: 1 },
      'wing-mid-l': { store: 'sd-10a', count: 1 },
      'wing-mid-r': { store: 'sd-10a', count: 1 },
      'wing-inner-l': { store: 'tank-1200l', count: 1 },
      'wing-inner-r': { store: 'tank-1200l', count: 1 },
    },
  },
  {
    id: 'block3',
    name: 'Block III: 2x PL-5E II, 4x PL-15E',
    fit: {
      gun: { store: 'gsh-23', count: 220 },
      'wing-outer-l': { store: 'pl-5e', count: 1 },
      'wing-outer-r': { store: 'pl-5e', count: 1 },
      'wing-mid-l': { store: 'pl-15e', count: 1 },
      'wing-mid-r': { store: 'pl-15e', count: 1 },
      'wing-inner-l': { store: 'pl-15e', count: 1 },
      'wing-inner-r': { store: 'pl-15e', count: 1 },
    },
  },
  {
    id: 'dogfight',
    name: 'Dogfight: 4x PL-5E II',
    fit: {
      gun: { store: 'gsh-23', count: 220 },
      'wing-outer-l': { store: 'pl-5e', count: 1 },
      'wing-outer-r': { store: 'pl-5e', count: 1 },
      'wing-mid-l': { store: 'pl-5e', count: 1 },
      'wing-mid-r': { store: 'pl-5e', count: 1 },
    },
  },
];

export const jf17Definition: AircraftDefinition = {
  ...tejasDefinition,
  id: 'jf-17',
  displayName: 'PAC JF-17 Thunder',
  stations: jf17Stations,
  loadouts: jf17Loadouts,
  defaultLoadoutId: 'bvr',
  hardpoints: hardpointsFor(jf17Stations, jf17Loadouts[0]!),
  sensors: { radar: 'klj-7a', iff: true, rwr: 'jf17-rwr', maws: true, countermeasures: { chaff: 60, flares: 60 } },
  // Bigger than the Tejas (conventional intakes, less composite): ~3 m^2 nose-on.
  signature: { rcsNoseOnM2: 3.0, rcsBroadsideM2: 9.0, hitEllipsoidBodyM: { x: 7.1, y: 2.4, z: 4.6 } },
};

// --- F-16 Block 52: M61 (modelled as the GSh-23 until guns get their own profiles), AIM-9M on the
// wingtips, AIM-120C-5 under the wings, 370 gal tanks. AN/APG-68(V)9.
const f16Stations: readonly StationDef[] = [
  station('gun', ['gsh-23'], 220),
  station('wing-outer-l', ['aim-9m'], 2),
  station('wing-outer-r', ['aim-9m'], 2),
  station('wing-mid-l', ['aim-120c', 'aim-9m'], 1),
  station('wing-mid-r', ['aim-120c', 'aim-9m'], 1),
  station('wing-inner-l', ['tank-1200l', 'aim-120c'], 1),
  station('wing-inner-r', ['tank-1200l', 'aim-120c'], 1),
  station('centreline', ['tank-725l'], 1),
];
const f16Loadouts: readonly LoadoutPreset[] = [
  {
    id: 'cap',
    name: 'CAP: 4x AIM-9M, 2x AIM-120C-5, 2x tanks',
    fit: {
      gun: { store: 'gsh-23', count: 220 },
      'wing-outer-l': { store: 'aim-9m', count: 2 },
      'wing-outer-r': { store: 'aim-9m', count: 2 },
      'wing-mid-l': { store: 'aim-120c', count: 1 },
      'wing-mid-r': { store: 'aim-120c', count: 1 },
      'wing-inner-l': { store: 'tank-1200l', count: 1 },
      'wing-inner-r': { store: 'tank-1200l', count: 1 },
    },
  },
  {
    id: 'bvr',
    name: 'BVR: 2x AIM-9M, 4x AIM-120C-5',
    fit: {
      gun: { store: 'gsh-23', count: 220 },
      'wing-outer-l': { store: 'aim-9m', count: 1 },
      'wing-outer-r': { store: 'aim-9m', count: 1 },
      'wing-mid-l': { store: 'aim-120c', count: 1 },
      'wing-mid-r': { store: 'aim-120c', count: 1 },
      'wing-inner-l': { store: 'aim-120c', count: 1 },
      'wing-inner-r': { store: 'aim-120c', count: 1 },
    },
  },
];

export const f16Definition: AircraftDefinition = {
  ...tejasDefinition,
  id: 'f-16',
  displayName: 'F-16 Block 52',
  stations: f16Stations,
  loadouts: f16Loadouts,
  defaultLoadoutId: 'cap',
  hardpoints: hardpointsFor(f16Stations, f16Loadouts[0]!),
  sensors: { radar: 'apg-68', iff: true, rwr: 'alr-69', maws: false, countermeasures: { chaff: 60, flares: 60 } },
  signature: { rcsNoseOnM2: 1.5, rcsBroadsideM2: 7.0, hitEllipsoidBodyM: { x: 7.5, y: 2.5, z: 4.7 } },
};
