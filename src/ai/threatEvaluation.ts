/**
 * src/ai/threatEvaluation.ts — contact scoring/prioritization and target
 * selection. See docs/spec/06-ai.md section 4.5.
 *
 * CONTRACT NOTE (reported in the module's return value, per the project's
 * "implement to it anyway" rule): `ScoreThreatContact` is typed in
 * contracts/ai.ts as `(self: PilotContext, contact: Readonly<Contact>) =>
 * number`, but 06-ai.md section 4.5's worked formula needs
 * `difficulty.saRadiusM` (from `AiDifficultyProfile`, which is not reachable
 * from a bare `PilotContext`) to normalise the range term. `difficulty` is
 * therefore added here as a third, OPTIONAL parameter — TypeScript accepts
 * this as still structurally assignable to `ScoreThreatContact` (a caller
 * using the 2-arg type never has to pass it) — defaulting to the `veteran`
 * profile's `saRadiusM` when omitted. Every call site inside this module
 * always passes the real difficulty explicitly, so in practice the fallback
 * is never exercised; it only exists to keep the function honestly typeable
 * against the contract's exact (under-specified) signature.
 */
import type { Contact, EntityId, EntityState, PilotContext } from '../contracts/core';
import type { AiDifficultyProfile, ScoreThreatContact } from '../contracts/ai';
import { AiDifficultyProfiles, ThreatWeights } from '../contracts/ai';
import { clamp } from '../math';
import { headingFromVelocity, computeAspectAngleRad } from './formation';

const FALLBACK_SA_RADIUS_M = AiDifficultyProfiles.veteran.saRadiusM;

/** The module's one ROE check: a contact is a candidate only if identified, hostile, and within SA radius. Never used to infer team on an unidentified contact. */
export function isHostileCandidate(
  self: Readonly<EntityState>,
  contact: Readonly<Contact>,
  difficulty: Readonly<AiDifficultyProfile>
): boolean {
  return contact.identified && contact.team !== self.team && contact.rangeM <= difficulty.saRadiusM;
}

// NOTE: exported WITHOUT a `: ScoreThreatContact` type annotation on the
// const itself — annotating it would pin every call site (including the
// ones two lines below, in this very file) to the contract's narrow 2-arg
// type, making the 3rd `difficulty` argument a compile error everywhere.
// `scoreThreatContactSatisfiesContract` below is the actual, checked proof
// of contract compliance; the exported symbol keeps its full, real 3-arg
// (3rd optional) inferred type so this module's own code — and pilotAi.ts —
// can call it with the difficulty it always has on hand.
function scoreThreatContactImpl(
  self: PilotContext,
  contact: Readonly<Contact>,
  difficulty?: Readonly<AiDifficultyProfile>
): number {
  const saRadiusM = difficulty ? difficulty.saRadiusM : FALLBACK_SA_RADIUS_M;

  const observedHeadingRad = headingFromVelocity(contact.vel);
  const aspectAngleRad = computeAspectAngleRad(observedHeadingRad, contact.pos, self.self.pos);
  const threatFromAspect = 1 - Math.abs(aspectAngleRad) / Math.PI;

  const rangeTerm = ThreatWeights.W_RANGE * (1 - clamp(contact.rangeM / saRadiusM, 0, 1));
  const closureTerm = ThreatWeights.W_CLOSURE * clamp(contact.closureMps / ThreatWeights.CLOSURE_NORM_MPS, -1, 1);
  const aspectTerm = ThreatWeights.W_ASPECT * threatFromAspect;
  const altTerm = ThreatWeights.W_ALT * clamp((contact.pos.y - self.self.pos.y) / ThreatWeights.ALT_NORM_M, -1, 1);

  return rangeTerm + closureTerm + aspectTerm + altTerm;
}
export const scoreThreatContact = scoreThreatContactImpl;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _scoreThreatContactSatisfiesContract: ScoreThreatContact = scoreThreatContactImpl;

/**
 * Scores every candidate in `contacts` (identified hostile, in `saRadiusM`)
 * and returns the highest scorer, or `undefined` if there are none. No
 * allocation (indexed loop, tracks best index/score as locals).
 */
export function pickBestCandidate(
  contacts: readonly Contact[],
  ctx: PilotContext,
  difficulty: Readonly<AiDifficultyProfile>
): Contact | undefined {
  let bestContact: Contact | undefined;
  let bestScore = -Infinity;
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    if (c === undefined) continue;
    if (!isHostileCandidate(ctx.self, c, difficulty)) continue;
    const score = scoreThreatContact(ctx, c, difficulty);
    if (score > bestScore) {
      bestScore = score;
      bestContact = c;
    }
  }
  return bestContact;
}

/** The current candidate with the smallest `rangeM`, or `undefined` if there are none. No allocation. */
export function nearestCandidate(
  contacts: readonly Contact[],
  ctx: PilotContext,
  difficulty: Readonly<AiDifficultyProfile>
): Contact | undefined {
  let nearest: Contact | undefined;
  let nearestRange = Infinity;
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    if (c === undefined) continue;
    if (!isHostileCandidate(ctx.self, c, difficulty)) continue;
    if (c.rangeM < nearestRange) {
      nearestRange = c.rangeM;
      nearest = c;
    }
  }
  return nearest;
}

/** Minimum `rangeM` among all current candidates, or `Infinity` if there are none. No allocation. */
export function nearestCandidateRangeM(
  contacts: readonly Contact[],
  ctx: PilotContext,
  difficulty: Readonly<AiDifficultyProfile>
): number {
  const c = nearestCandidate(contacts, ctx, difficulty);
  return c === undefined ? Infinity : c.rangeM;
}

/**
 * Target selection with switch hysteresis (06-ai.md section 4.5):
 * `perceivedContacts` is the reaction-delay-filtered contact list
 * (`pilotAi.ts`'s `filterPerceived`), not necessarily `ctx.contacts` itself.
 */
export function selectTarget(
  ctx: PilotContext,
  perceivedContacts: readonly Contact[],
  currentTargetId: EntityId | undefined,
  difficulty: Readonly<AiDifficultyProfile>
): Contact | undefined {
  let bestContact: Contact | undefined;
  let bestScore = -Infinity;
  let currentContact: Contact | undefined;
  let currentScore = -Infinity;

  for (let i = 0; i < perceivedContacts.length; i++) {
    const c = perceivedContacts[i];
    if (c === undefined) continue;
    if (!isHostileCandidate(ctx.self, c, difficulty)) continue;
    const score = scoreThreatContact(ctx, c, difficulty);
    if (score > bestScore) {
      bestScore = score;
      bestContact = c;
    }
    if (currentTargetId !== undefined && c.id === currentTargetId) {
      currentContact = c;
      currentScore = score;
    }
  }

  if (currentContact === undefined) return bestContact;
  if (bestContact === undefined) return currentContact;
  if (bestScore - currentScore > ThreatWeights.TARGET_SWITCH_HYSTERESIS) return bestContact;
  return currentContact;
}
