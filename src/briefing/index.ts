/**
 * src/briefing/index.ts — the mission intros (cinematic war-room briefings) by mission. A campaign
 * mission with an entry here plays its intro while it loads (src/main.ts startBriefingIntro).
 */
import type { BriefingScript } from './script';
import { SIMIKOT_LIFELINE_BRIEFING } from './scripts/simikotLifeline';

export const BRIEFINGS: readonly BriefingScript[] = [SIMIKOT_LIFELINE_BRIEFING];

export function briefingFor(missionId: string): BriefingScript | undefined {
  return BRIEFINGS.find((b) => b.missionId === missionId);
}
