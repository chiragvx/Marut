/**
 * src/ground/placement.ts — turns a mission's ground groups (site templates and explicit units) into
 * units on the terrain, and an airbase layout's structures into static targets.
 *
 * Heading convention (world): 0 = north (-z), +x east. Site frame: +dx along the site heading,
 * +dz to its right.
 */
import type { HeightSampler, Team } from '../contracts/core';
import type { AirportLayout } from '../contracts/airport';
import type { GroundUnitType, MissionGroundGroup } from '../contracts/ground';
import { GROUND_UNIT_TYPES, SITE_TEMPLATES, STRUCTURE_TARGETS } from '../catalog/groundUnits';
import type { GroundTargetSet } from './groundTargets';

export interface UnitPlacement {
  groupId: string;
  /** The unit's index within its group. */
  index: number;
  type: GroundUnitType;
  team: Team;
  x: number;
  /** Ground height at (x, z). */
  groundY: number;
  z: number;
  headingRad: number;
}

/** Every unit of every group, placed on the ground. Unknown unit types and templates are skipped. */
export function placeGroundGroups(groups: readonly MissionGroundGroup[], sampler: HeightSampler): UnitPlacement[] {
  const out: UnitPlacement[] = [];
  for (const g of groups) {
    const units = [...(g.template ? (SITE_TEMPLATES[g.template]?.units ?? []) : []), ...(g.units ?? [])];
    const fx = Math.sin(g.headingRad), fz = -Math.cos(g.headingRad);
    const rx = Math.cos(g.headingRad), rz = Math.sin(g.headingRad);
    units.forEach((u, index) => {
      const type = GROUND_UNIT_TYPES[u.type];
      if (!type) return;
      const x = g.pos.x + u.dx * fx + u.dz * rx;
      const z = g.pos.z + u.dx * fz + u.dz * rz;
      out.push({ groupId: g.id, index, type, team: g.team, x, z, groundY: sampler.heightAt(x, z), headingRad: g.headingRad + (u.headingRad ?? 0) });
    });
  }
  return out;
}

/** Adds an airbase's structures (the kinds that are targets) to the set, on its field elevation. */
export function addAirbaseStructures(set: GroundTargetSet, layout: Partial<AirportLayout>): void {
  const team: Team = layout.side === 'hostile' ? 1 : 0;
  const elev = layout.elevationM ?? 0;
  for (const s of layout.structures ?? []) {
    const def = STRUCTURE_TARGETS[s.kind];
    if (!def) continue;
    set.add({
      entityId: -1,
      targetId: `${layout.id}:${s.id}`,
      typeId: s.kind,
      groupId: s.group ?? '',
      team,
      armor: def.armor,
      toughness: def.toughness,
      burnSec: def.burnSec,
      pos: { x: s.worldX, y: elev + s.heightM / 2, z: s.worldZ },
      headingRad: s.headingRad,
      half: { x: s.lengthM / 2, y: s.heightM / 2, z: s.widthM / 2 },
    });
  }
}
