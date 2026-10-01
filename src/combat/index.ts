/**
 * src/combat/index.ts — barrel re-export for the whole combat module.
 * See docs/spec/07-combat.md section 3 for the grouping this mirrors.
 */

// 3.2 Weapon stations & loadout
export { createWeaponsState, writeCombatStatus, createCombatRngState, fireWeapons, computeStoresLoad, cycleSelectedStore, findStationWithStore, countermeasureRelease, combatRand01, updateAgSight, CCRP_RELEASE_CROSS_M, AG_SIGHT_HZ } from './weaponStation';
export { predictImpact, ccrpSolution } from './agSight';
export { createPodState, updatePod } from './targetingPod';
export * from './countermeasures';

// 3.3 Damage
export { createDamageState, applyHit, rollSubsystemHit, subsystemHitFromU01 } from './subsystemDamage';

// 3.4 Sensors / radar / RWR
export { updateSensors, radarDetectionRangeM, computeGeometry, computeMissileThreat } from './radarModel';
export { irDetectionRangeM, updateIrGuidance, rotateTowards } from './irMissileSeeker';

// 3.5 Projectile flight
export { createProjectilePool, resetProjectile, initProjectile, stepProjectile } from './gunBallistics';
export { computePnAccel } from './proportionalNavigation';
export { updateRadarMissileGuidance } from './radarMissile';

// 3.6 Hit detection
export { segmentHitsEllipsoid, closestApproachOnSegment } from './hitDetection';

// 3.7 Gunsight
export { computeLeadSolution } from './leadComputingSight';

// 3.8 Events
export { missileKillProbability, pushExplosionEvent, resolveProjectileHit } from './effectsEvents';

// Re-export every constant/type from contracts/combat so consumers need only this barrel.
export * from '../contracts/combat';
export { GENERIC_GUN_PROFILE, GENERIC_IR_MISSILE_PROFILE, GENERIC_RADAR_MISSILE_PROFILE, GENERIC_RADAR_PROFILE, defaultWeaponProfile, projectileProfile } from './weaponProfiles';
export { isaDensityKgM3 } from './isaDensity';
export { terrainLineOfSight, rayToGround, MAX_LOS_SAMPLES, DEFAULT_LOS_STEP_M } from './lineOfSight';
export { AirDefenceNetwork, type AdSiteSpec, type AdUnitSpec, type AdEmission } from './airDefence';
