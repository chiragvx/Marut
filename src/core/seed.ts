/**
 * src/core/seed.ts — module 10's own deterministic sub-seed derivation.
 *
 * Deliberately distinct from src/math's `deriveSubSeed` (contracts/math.ts):
 * this is module 10's own FNV-1a-style hash per 10-core-worker.md section
 * 4.7, with its own verified worked examples. Used for `subSeed(missionSeed,
 * 'wind')` (wind.ts) and `subSeed(missionSeed, 'ai:' + flightId + ':' + j)`
 * (world.ts, AI spawn seeding).
 */

/** FNV-1a-style 32-bit hash of `masterSeed` folded with `tag`'s characters. Deterministic, allocation-free, platform-independent (Math.imul + >>> only). */
export function subSeed(masterSeed: number, tag: string): number {
  let h = (0x811c9dc5 ^ masterSeed) >>> 0;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
