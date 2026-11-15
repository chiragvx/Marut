/**
 * src/core/missions/campaigns.ts — campaigns: a run of missions told as one story, shown as their
 * own group on the Missions screen (src/ui/missions.ts). A campaign has numbered slots; a slot with
 * a `missionId` is built, the others show as "coming soon" cards (title and a one-line teaser).
 *
 * Unlocking: the built slots open in order. The first built slot is open; each later built slot
 * opens once every built slot before it has been completed. Slots not built yet never block the
 * ones after them (with one mission built, it is simply open).
 *
 * The Himalaya arc is docs/spec/himalaya-theatre.md section 8 (a fictional story). Its Free Flight
 * entries (himalaya-free / -ngari / -simikot) stay in Free Flight, not here.
 */
import type { BuiltinMissionId } from './index';

export interface CampaignSlot {
  /** 1-based position in the arc. */
  slot: number;
  title: string;
  /** One line for the card. */
  teaser: string;
  aircraft: 'C-17' | 'Tejas';
  /** The mission that flies this slot; absent: not built yet ("coming soon"). */
  missionId?: BuiltinMissionId;
}

export interface Campaign {
  id: string;
  /** "Himalaya" */
  region: string;
  /** "Operation Him Setu" */
  name: string;
  /** One or two lines under the campaign's heading. */
  blurb: string;
  slots: readonly CampaignSlot[];
}

export type CampaignSlotState = 'open' | 'locked' | 'soon';

export const HIMALAYA_CAMPAIGN: Campaign = {
  id: 'himalaya',
  region: 'Himalaya',
  name: 'Operation Him Setu',
  blurb: 'Chinese columns are pushing down the Karnali into Humla. Nepal has asked India for help: hold the valleys open from the air, from Naini Saini to the plateau.',
  slots: [
    { slot: 1, title: 'First Lift', aircraft: 'C-17', teaser: 'Sixty troops into the one-way strip at Gunji: no go-around past the commit point.' },
    { slot: 2, title: 'Simikot Lifeline', aircraft: 'C-17', teaser: 'Up the Karnali gorge to airdrop sixteen tonnes on the runway at Simikot.', missionId: 'himalaya-airdrop' },
    { slot: 3, title: 'Lipulekh Watch', aircraft: 'Tejas', teaser: 'Pop up over the pass and stop a column on the road from Purang.' },
    { slot: 4, title: 'Kailash Sweep', aircraft: 'Tejas', teaser: 'Clear a fighter pair over the lakes while a second C-17 lift goes in.' },
    { slot: 5, title: 'Lights Out', aircraft: 'Tejas', teaser: 'Through the Zanda canyon to close the runway at Ngari Gunsa, and spare its taxiway.' },
    { slot: 6, title: 'Taxiway', aircraft: 'C-17', teaser: 'Land a C-17 on 1,200 m of taxiway at 4,274 m before dawn.' },
  ],
};

export const CAMPAIGNS: readonly Campaign[] = [HIMALAYA_CAMPAIGN];

/** The campaign (and slot) a mission belongs to, if any. */
export function campaignOf(missionId: string): { campaign: Campaign; slot: CampaignSlot } | undefined {
  for (const campaign of CAMPAIGNS) {
    const slot = campaign.slots.find((s) => s.missionId === missionId);
    if (slot) return { campaign, slot };
  }
  return undefined;
}

/** Every mission any campaign holds (the Missions screen lists them in their campaign, not with the others). */
export function campaignMissionIds(): BuiltinMissionId[] {
  return CAMPAIGNS.flatMap((c) => c.slots.flatMap((s) => (s.missionId ? [s.missionId] : [])));
}

/**
 * Each slot's state: 'soon' (not built), 'open' or 'locked' (a built slot before it not completed
 * yet). `playable` says whether this build opens a mission at all (catalogue.ts PLAYABLE_MISSIONS);
 * a built slot whose mission is not playable shows as locked.
 */
export function campaignSlotStates(
  campaign: Campaign,
  progress: Readonly<Record<string, { completed: boolean } | undefined>>,
  playable: (id: BuiltinMissionId) => boolean = () => true
): CampaignSlotState[] {
  let blocked = false;
  return campaign.slots.map((s) => {
    if (!s.missionId) return 'soon';
    const state: CampaignSlotState = blocked || !playable(s.missionId) ? 'locked' : 'open';
    if (!progress[s.missionId]?.completed) blocked = true;
    return state;
  });
}

/** Whether a campaign mission is open to fly (true for a mission in no campaign). */
export function campaignMissionOpen(missionId: string, progress: Readonly<Record<string, { completed: boolean } | undefined>>, playable?: (id: BuiltinMissionId) => boolean): boolean {
  const c = campaignOf(missionId);
  if (!c) return true;
  return campaignSlotStates(c.campaign, progress, playable)[c.campaign.slots.indexOf(c.slot)] === 'open';
}
