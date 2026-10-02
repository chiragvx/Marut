/**
 * src/catalog/groundUnits.ts — ground unit types, site templates, and what each airbase structure
 * kind is as a target. Pure data (src/contracts only). Sizes are public dimensions of the systems
 * they stand for; armour classes and toughness are gameplay abstractions of the damage model
 * (contracts/ground.ts BLAST_KILL_Z).
 *
 * Adding a target type = one entry in GROUND_UNIT_TYPES (+ its code appended to GROUND_TYPE_IDS, +
 * a render model if no existing one fits). Adding a site = one SITE_TEMPLATES entry.
 */
import type { GroundUnitType, SiteTemplate, ArmorClass } from '../contracts/ground';

const t = (u: GroundUnitType): GroundUnitType => u;

export const GROUND_UNIT_TYPES: Readonly<Record<string, GroundUnitType>> = {
  // --- Soft-skinned vehicles ---
  'truck-cargo': t({ id: 'truck-cargo', name: 'Cargo truck (6x6)', category: 'vehicle', model: 'truck', armor: 'soft', halfExtentsM: { x: 3.8, y: 1.5, z: 1.25 }, toughness: 1, heat: 0.4, rcsM2: 20, maxSpeedMps: 20, burnSec: 60 }),
  'truck-fuel': t({ id: 'truck-fuel', name: 'Fuel bowser', category: 'vehicle', model: 'fuel-truck', armor: 'soft', halfExtentsM: { x: 4.0, y: 1.5, z: 1.25 }, toughness: 1, heat: 0.4, rcsM2: 22, maxSpeedMps: 18, burnSec: 150 }),
  jeep: t({ id: 'jeep', name: 'Light vehicle', category: 'vehicle', model: 'jeep', armor: 'soft', halfExtentsM: { x: 2.0, y: 1.0, z: 0.9 }, toughness: 0.6, heat: 0.3, rcsM2: 6, maxSpeedMps: 25, burnSec: 30 }),
  generator: t({ id: 'generator', name: 'Generator trailer', category: 'vehicle', model: 'generator', armor: 'soft', halfExtentsM: { x: 2.0, y: 1.0, z: 1.0 }, toughness: 0.6, heat: 0.7, rcsM2: 5, maxSpeedMps: 0, burnSec: 40 }),
  'command-post': t({ id: 'command-post', name: 'Command post van', category: 'command', model: 'van', armor: 'soft', halfExtentsM: { x: 3.5, y: 1.6, z: 1.2 }, toughness: 1, heat: 0.5, rcsM2: 18, maxSpeedMps: 18, burnSec: 60 }),

  // --- Armour ---
  apc: t({ id: 'apc', name: 'APC (tracked)', category: 'armor', model: 'apc', armor: 'light', halfExtentsM: { x: 3.4, y: 1.3, z: 1.5 }, toughness: 1, heat: 0.5, rcsM2: 15, maxSpeedMps: 16, burnSec: 60 }),
  'tank-mbt': t({ id: 'tank-mbt', name: 'Main battle tank (Al-Khalid)', category: 'armor', model: 'tank', armor: 'armored', halfExtentsM: { x: 3.5, y: 1.2, z: 1.7 }, toughness: 1, heat: 0.6, rcsM2: 20, maxSpeedMps: 18, burnSec: 90 }),

  // --- Air defence ---
  'sam-tel': t({ id: 'sam-tel', name: 'LY-80 launcher (TEL)', category: 'sam_launcher', model: 'tel-mr', armor: 'light', halfExtentsM: { x: 5.5, y: 1.8, z: 1.4 }, toughness: 1, heat: 0.35, rcsM2: 30, maxSpeedMps: 16, burnSec: 70, rounds: 6 }),
  'sam-tel-lr': t({ id: 'sam-tel-lr', name: 'HQ-9/P launcher (TEL)', category: 'sam_launcher', model: 'tel-lr', armor: 'light', halfExtentsM: { x: 6.0, y: 2.0, z: 1.5 }, toughness: 1, heat: 0.35, rcsM2: 35, maxSpeedMps: 16, burnSec: 70, rounds: 4 }),
  'sam-tel-sr': t({ id: 'sam-tel-sr', name: 'FM-90 launcher', category: 'sam_launcher', model: 'tel-sr', armor: 'light', halfExtentsM: { x: 4.0, y: 1.6, z: 1.4 }, toughness: 1, heat: 0.4, rcsM2: 20, maxSpeedMps: 16, burnSec: 50, rounds: 4 }),
  'radar-search': t({ id: 'radar-search', name: 'SAM search radar', category: 'radar', model: 'radar-search', armor: 'soft', halfExtentsM: { x: 4.5, y: 2.5, z: 1.4 }, toughness: 1, heat: 0.5, rcsM2: 60, maxSpeedMps: 14, burnSec: 40 }),
  'radar-track': t({ id: 'radar-track', name: 'SAM engagement radar', category: 'radar', model: 'radar-track', armor: 'soft', halfExtentsM: { x: 4.0, y: 2.3, z: 1.4 }, toughness: 1, heat: 0.5, rcsM2: 50, maxSpeedMps: 14, burnSec: 40 }),
  'radar-ew': t({ id: 'radar-ew', name: 'Early-warning radar (YLC-8B)', category: 'radar', model: 'radar-ew', armor: 'soft', halfExtentsM: { x: 5.0, y: 4.0, z: 3.0 }, toughness: 1.5, heat: 0.5, rcsM2: 150, maxSpeedMps: 0, burnSec: 40 }),
  'aaa-35': t({ id: 'aaa-35', name: '35 mm twin AA gun (GDF)', category: 'aaa', model: 'aaa-twin', armor: 'light', halfExtentsM: { x: 3.8, y: 1.3, z: 1.2 }, toughness: 0.8, heat: 0.2, rcsM2: 8, maxSpeedMps: 0, burnSec: 20, rounds: 400 }),
  'manpads-team': t({ id: 'manpads-team', name: 'MANPADS team (Anza)', category: 'manpads', model: 'manpads', armor: 'soft', halfExtentsM: { x: 1.0, y: 0.9, z: 1.0 }, toughness: 0.4, heat: 0.15, rcsM2: 1, maxSpeedMps: 0, burnSec: 0, rounds: 2 }),

  // --- Fixed targets ---
  bunker: t({ id: 'bunker', name: 'Bunker', category: 'structure', model: 'bunker', armor: 'hardened', halfExtentsM: { x: 4.0, y: 1.5, z: 4.0 }, toughness: 1, heat: 0.1, rcsM2: 40, maxSpeedMps: 0, burnSec: 0 }),
  'building-target': t({ id: 'building-target', name: 'Building', category: 'structure', model: 'building', armor: 'light', halfExtentsM: { x: 6.0, y: 3.0, z: 5.0 }, toughness: 2, heat: 0.2, rcsM2: 200, maxSpeedMps: 0, burnSec: 90 }),
};

/** An airbase structure kind as a target: armour, toughness, burn time; `null` = not a target (earthworks). */
export const STRUCTURE_TARGETS: Readonly<Record<string, { armor: ArmorClass; toughness: number; burnSec: number } | null>> = {
  shelter: { armor: 'hardened', toughness: 1, burnSec: 60 },
  hangar: { armor: 'light', toughness: 3, burnSec: 120 },
  building: { armor: 'light', toughness: 2, burnSec: 90 },
  control_tower: { armor: 'light', toughness: 1.5, burnSec: 60 },
  fuel_tank: { armor: 'soft', toughness: 1, burnSec: 300 },
  fuel_bund: null,
  magazine: { armor: 'hardened', toughness: 1, burnSec: 30 },
  water_tower: { armor: 'soft', toughness: 1, burnSec: 0 },
  radar: { armor: 'soft', toughness: 1, burnSec: 30 },
};

export const SITE_TEMPLATES: Readonly<Record<string, SiteTemplate>> = {
  // LY-80 (HQ-16) medium-range SAM battery: search radar at the centre, engagement radar forward,
  // four TELs in a diamond ~300 m out, command post and generator behind.
  'sam-mr-battery': {
    id: 'sam-mr-battery',
    name: 'LY-80 battery',
    airDefence: { name: 'LY-80', rwrSymbol: 'L8', sensor: 'radar', weapon: 'ly-80-msl', searchRangeM: 85000, trackRangeM: 60000, minRangeM: 3000, maxRangeM: 40000, maxAltM: 15000, minAltAglM: 25, lockTimeSec: 3, salvo: 2, salvoIntervalSec: 3 },
    units: [
      { type: 'radar-search', dx: 0, dz: 0 },
      { type: 'radar-track', dx: 120, dz: 0 },
      { type: 'sam-tel', dx: 300, dz: 0 },
      { type: 'sam-tel', dx: 0, dz: 300, headingRad: 0.3 },
      { type: 'sam-tel', dx: -300, dz: 0, headingRad: -0.2 },
      { type: 'sam-tel', dx: 0, dz: -300, headingRad: 0.2 },
      { type: 'command-post', dx: -90, dz: 60, headingRad: 1.2 },
      { type: 'generator', dx: -100, dz: 80, headingRad: 1.2 },
    ],
  },
  // HQ-9/P long-range SAM battery: bigger radars, six TELs on a wide ring.
  'sam-lr-battery': {
    id: 'sam-lr-battery',
    name: 'HQ-9/P battery',
    airDefence: { name: 'HQ-9/P', rwrSymbol: '9', sensor: 'radar', weapon: 'hq-9-msl', searchRangeM: 150000, trackRangeM: 120000, minRangeM: 6000, maxRangeM: 80000, maxAltM: 25000, minAltAglM: 30, lockTimeSec: 4, salvo: 2, salvoIntervalSec: 4 },
    units: [
      { type: 'radar-search', dx: -60, dz: 0 },
      { type: 'radar-track', dx: 100, dz: 0 },
      { type: 'sam-tel-lr', dx: 450, dz: 0 },
      { type: 'sam-tel-lr', dx: 225, dz: 390, headingRad: 0.2 },
      { type: 'sam-tel-lr', dx: -225, dz: 390, headingRad: -0.2 },
      { type: 'sam-tel-lr', dx: -450, dz: 0 },
      { type: 'sam-tel-lr', dx: -225, dz: -390, headingRad: 0.2 },
      { type: 'sam-tel-lr', dx: 225, dz: -390, headingRad: -0.2 },
      { type: 'command-post', dx: -120, dz: 80, headingRad: 1.4 },
      { type: 'generator', dx: -130, dz: 100, headingRad: 1.4 },
    ],
  },
  // FM-90 short-range section: one radar vehicle, two launchers.
  'sam-sr-section': {
    id: 'sam-sr-section',
    name: 'FM-90 section',
    airDefence: { name: 'FM-90', rwrSymbol: 'FM', sensor: 'radar', weapon: 'fm-90-msl', searchRangeM: 25000, trackRangeM: 20000, minRangeM: 700, maxRangeM: 15000, maxAltM: 6000, minAltAglM: 15, lockTimeSec: 2.5, salvo: 1, salvoIntervalSec: 3 },
    units: [
      { type: 'radar-track', dx: 0, dz: 0 },
      { type: 'sam-tel-sr', dx: 80, dz: 60 },
      { type: 'sam-tel-sr', dx: 80, dz: -60 },
    ],
  },
  // --- Friendly (Indian) air defence ---
  // Akash battery: the 3D central acquisition radar, the Rajendra phased-array fire-control radar,
  // four launchers (three missiles each).
  'akash-battery': {
    id: 'akash-battery',
    name: 'Akash battery',
    airDefence: { name: 'Akash', rwrSymbol: 'AK', sensor: 'radar', weapon: 'akash-msl', searchRangeM: 90000, trackRangeM: 60000, minRangeM: 4000, maxRangeM: 27000, maxAltM: 18000, minAltAglM: 30, lockTimeSec: 3, salvo: 2, salvoIntervalSec: 3 },
    units: [
      { type: 'radar-search', dx: -80, dz: 0 },
      { type: 'radar-track', dx: 60, dz: 0 },
      { type: 'sam-tel', dx: 260, dz: 150 },
      { type: 'sam-tel', dx: 260, dz: -150, headingRad: 0.2 },
      { type: 'sam-tel', dx: -60, dz: 280, headingRad: -0.3 },
      { type: 'sam-tel', dx: -60, dz: -280, headingRad: 0.3 },
      { type: 'command-post', dx: -120, dz: 70, headingRad: 1.3 },
      { type: 'generator', dx: -130, dz: 95, headingRad: 1.3 },
    ],
  },
  // SPYDER-SR: the EL/M-2106 search radar and command vehicle, two launch trucks (Derby).
  'spyder-sr': {
    id: 'spyder-sr',
    name: 'SPYDER-SR',
    airDefence: { name: 'SPYDER', rwrSymbol: 'SP', sensor: 'radar', weapon: 'spyder-derby', searchRangeM: 35000, trackRangeM: 25000, minRangeM: 1000, maxRangeM: 15000, maxAltM: 9000, minAltAglM: 20, lockTimeSec: 2, salvo: 2, salvoIntervalSec: 2 },
    units: [
      { type: 'radar-track', dx: 0, dz: 0 },
      { type: 'sam-tel-sr', dx: 90, dz: 70 },
      { type: 'sam-tel-sr', dx: 90, dz: -70, headingRad: 0.2 },
      { type: 'command-post', dx: -60, dz: 40, headingRad: 1.2 },
    ],
  },
  // MR-SAM (Barak-8): the EL/M-2084 multi-mission radar and three launchers.
  'mrsam-battery': {
    id: 'mrsam-battery',
    name: 'MR-SAM battery',
    airDefence: { name: 'MR-SAM', rwrSymbol: 'MR', sensor: 'radar', weapon: 'mrsam-msl', searchRangeM: 200000, trackRangeM: 100000, minRangeM: 1500, maxRangeM: 70000, maxAltM: 16000, minAltAglM: 25, lockTimeSec: 3, salvo: 2, salvoIntervalSec: 3 },
    units: [
      { type: 'radar-search', dx: 0, dz: 0 },
      { type: 'radar-track', dx: 90, dz: 30 },
      { type: 'sam-tel-lr', dx: 350, dz: 0 },
      { type: 'sam-tel-lr', dx: 200, dz: 300, headingRad: 0.25 },
      { type: 'sam-tel-lr', dx: 200, dz: -300, headingRad: -0.25 },
      { type: 'command-post', dx: -110, dz: 70, headingRad: 1.4 },
      { type: 'generator', dx: -120, dz: 95, headingRad: 1.4 },
    ],
  },
  // Two twin 35 mm guns with their Skyguard fire-control radar.
  'aaa-site': {
    id: 'aaa-site',
    name: '35 mm AA site',
    airDefence: { name: '35 mm Skyguard', rwrSymbol: 'A', sensor: 'radar', weapon: '35mm-gdf', searchRangeM: 20000, trackRangeM: 15000, minRangeM: 0, maxRangeM: 4000, maxAltM: 3000, minAltAglM: 5, lockTimeSec: 1.5, salvo: 1, salvoIntervalSec: 0 },
    units: [
      { type: 'radar-track', dx: 0, dz: 0 },
      { type: 'aaa-35', dx: 90, dz: 50 },
      { type: 'aaa-35', dx: 90, dz: -50, headingRad: 0.4 },
    ],
  },
  'ew-site': {
    id: 'ew-site',
    name: 'Early-warning radar site',
    airDefence: { name: 'EW radar', rwrSymbol: 'EW', sensor: 'radar', searchRangeM: 250000, trackRangeM: 0, minRangeM: 0, maxRangeM: 0, maxAltM: 30000, minAltAglM: 60, lockTimeSec: 0, salvo: 0, salvoIntervalSec: 0 },
    units: [
      { type: 'radar-ew', dx: 0, dz: 0 },
      { type: 'command-post', dx: -60, dz: 40, headingRad: 1.5 },
      { type: 'generator', dx: -70, dz: 60, headingRad: 1.5 },
    ],
  },
  'manpads-pair': {
    id: 'manpads-pair',
    name: 'MANPADS teams',
    airDefence: { name: 'MANPADS', rwrSymbol: '', sensor: 'optical', weapon: 'anza-mk3', searchRangeM: 7000, trackRangeM: 6000, minRangeM: 400, maxRangeM: 5000, maxAltM: 3500, minAltAglM: 0, lockTimeSec: 2, salvo: 1, salvoIntervalSec: 8 },
    units: [
      { type: 'manpads-team', dx: 0, dz: 0 },
      { type: 'manpads-team', dx: -40, dz: 70 },
    ],
  },
  // A supply convoy in column along its heading, 40 m apart.
  'convoy-supply': {
    id: 'convoy-supply',
    name: 'Supply convoy',
    units: [
      { type: 'jeep', dx: 0, dz: 0 },
      { type: 'truck-cargo', dx: -40, dz: 0 },
      { type: 'truck-cargo', dx: -80, dz: 0 },
      { type: 'truck-fuel', dx: -120, dz: 0 },
      { type: 'truck-cargo', dx: -160, dz: 0 },
      { type: 'truck-fuel', dx: -200, dz: 0 },
      { type: 'truck-cargo', dx: -240, dz: 0 },
      { type: 'jeep', dx: -280, dz: 0 },
    ],
  },
  'armor-platoon': {
    id: 'armor-platoon',
    name: 'Armoured platoon',
    units: [
      { type: 'tank-mbt', dx: 0, dz: 0 },
      { type: 'tank-mbt', dx: -60, dz: -45 },
      { type: 'tank-mbt', dx: -60, dz: 45 },
      { type: 'apc', dx: -130, dz: 0 },
    ],
  },
  // A weapons range: targets spread out so each weapon can be tried on its own.
  'range-targets': {
    id: 'range-targets',
    name: 'Range targets',
    units: [
      { type: 'truck-cargo', dx: 0, dz: -150 },
      { type: 'truck-cargo', dx: 20, dz: -120, headingRad: 0.4 },
      { type: 'truck-fuel', dx: -20, dz: -90 },
      { type: 'apc', dx: 0, dz: 0 },
      { type: 'tank-mbt', dx: 40, dz: 30, headingRad: -0.5 },
      { type: 'tank-mbt', dx: -30, dz: 60, headingRad: 0.7 },
      { type: 'building-target', dx: 200, dz: 150 },
      { type: 'building-target', dx: 230, dz: 190, headingRad: 1.57 },
      { type: 'bunker', dx: -250, dz: 150 },
      { type: 'sam-tel', dx: -200, dz: -200, headingRad: 0.8 },
      { type: 'radar-search', dx: -260, dz: -230 },
    ],
  },
};
