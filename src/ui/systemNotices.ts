/**
 * src/ui/systemNotices.ts — what the player's aircraft systems just did, in words, for the small
 * notices (src/ui/toasts.ts): "Gear down", "Flaps 1/2", "Cargo ramp opening", "Reverse thrust"...
 *
 * Driven by the state the snapshots report, not by key presses, so a notice says what really
 * happened (the ramp is "open" when it reaches the end of its travel, the flaps are "1/2" once they
 * get there; a gear lever moved on the ground, where the gear stays locked down, says nothing).
 *
 * Fighters keep it quiet (gear and airbrake only, end states only); transports also report the
 * gear and ramp starting to move, flaps, slats, spoilers and reversers.
 *
 * Pure: `update` takes this frame's state and returns the notices it causes (the first call after
 * a reset only records the state).
 */
import { FLAP_SETTLED_EPS, flapDetentName } from '../hud/flapStatus';

export interface SystemState {
  /** 0 = up .. 1 = down. */
  gearPos: number;
  /** The airbrake flag (the fighters' speed brake; the C-17's spoilers follow it too). */
  airbrake: boolean;
  /** Flap lever detent and the flaps' position, detent units (SnapshotHudExt.FLAP_*); negative or absent = no flaps. */
  flapLever?: number;
  flapPos?: number;
  /** Transports (SnapshotEntity.HIGH_LIFT / ENGINES), 0..1. */
  slats?: number;
  spoilers?: number;
  ramp?: number;
  /** The most deployed thrust reverser, 0..1. */
  reverser?: number;
}

export interface NoticeProfile {
  /** A transport: the fuller set of notices. */
  transport: boolean;
  /** Flap detent names (AircraftDefinition.highLift.detents). */
  flapNames?: readonly string[];
}

export interface SystemNotices {
  update(s: Readonly<SystemState>): string[];
  /** Forget the last state (a new flight). */
  reset(profile?: NoticeProfile): void;
}

/** Gear and ramp count as at an end of their travel within this. */
const END_EPS = 0.01;
/** Spoilers and reversers: deployed above DEPLOYED, stowed below STOWED (hysteresis). */
const DEPLOYED = 0.6;
const STOWED = 0.1;

/** Notice for a flap detent reached. */
export function flapNotice(names: readonly string[] | undefined, detent: number): string {
  const n = flapDetentName(names, detent);
  if (n === 'UP') return 'Flaps up';
  if (n === 'SLATS') return 'Slats extended';
  return `Flaps ${n}`;
}

interface Travel {
  /** -1 = moving towards 0 (closing / retracting), +1 = towards 1, 0 = still. */
  dir: number;
}

export function createSystemNotices(initial: NoticeProfile = { transport: false }): SystemNotices {
  let profile = initial;
  let prev: Required<SystemState> | undefined;
  const gear: Travel = { dir: 0 };
  const ramp: Travel = { dir: 0 };
  let spoilersOut = false;
  let reverseOn = false;
  let flapsAt = -1;
  /** The last detent the flaps settled at (kept while they travel). */
  let lastSettled = 0;
  let slatsOut = false;

  /** Start/end notices for a 0..1 travel (gear, ramp). `startText(dir)` undefined = no start notice. */
  const travel = (t: Travel, was: number, now: number, out: string[], startText: (dir: number) => string | undefined, endText: (atOne: boolean) => string): void => {
    const d = now - was;
    if (Math.abs(d) > 1e-4) {
      const dir = Math.sign(d);
      if (dir !== t.dir) {
        const s = startText(dir);
        // Starting from an end (or turning round part-way).
        if (s && (t.dir !== 0 || was <= END_EPS || was >= 1 - END_EPS)) out.push(s);
        t.dir = dir;
      }
    }
    if (t.dir > 0 && now >= 1 - END_EPS) {
      out.push(endText(true));
      t.dir = 0;
    } else if (t.dir < 0 && now <= END_EPS) {
      out.push(endText(false));
      t.dir = 0;
    }
  };

  return {
    reset(p) {
      if (p) profile = p;
      prev = undefined;
      gear.dir = 0;
      ramp.dir = 0;
    },
    update(s) {
      const cur: Required<SystemState> = {
        gearPos: s.gearPos,
        airbrake: s.airbrake,
        flapLever: s.flapLever ?? -1,
        flapPos: s.flapPos ?? -1,
        slats: s.slats ?? 0,
        spoilers: s.spoilers ?? 0,
        ramp: s.ramp ?? 0,
        reverser: s.reverser ?? 0,
      };
      const out: string[] = [];
      if (!prev) {
        prev = cur;
        spoilersOut = cur.spoilers > DEPLOYED;
        reverseOn = cur.reverser > DEPLOYED;
        flapsAt = cur.flapPos >= 0 && Math.abs(cur.flapPos - cur.flapLever) <= FLAP_SETTLED_EPS ? cur.flapLever : -1;
        lastSettled = Math.max(0, Math.round(cur.flapPos));
        slatsOut = cur.slats > 1 - END_EPS;
        // An end state is where the travel rests.
        return out;
      }
      const transport = profile.transport;

      travel(
        gear,
        prev.gearPos,
        cur.gearPos,
        out,
        (dir) => (transport ? (dir > 0 ? 'Gear extending' : 'Gear retracting') : undefined),
        (down) => (down ? 'Gear down' : 'Gear up')
      );

      if (!transport) {
        if (cur.airbrake !== prev.airbrake) out.push(cur.airbrake ? 'Airbrake out' : 'Airbrake in');
      } else {
        // Spoilers (B, or the ground spoilers deploying on touchdown).
        if (!spoilersOut && cur.spoilers > DEPLOYED) {
          spoilersOut = true;
          out.push('Spoilers deployed');
        } else if (spoilersOut && cur.spoilers < STOWED) {
          spoilersOut = false;
          out.push('Spoilers retracted');
        }
        if (!reverseOn && cur.reverser > DEPLOYED) {
          reverseOn = true;
          out.push('Reverse thrust');
        } else if (reverseOn && cur.reverser < STOWED) {
          reverseOn = false;
          out.push('Reversers stowed');
        }
        travel(
          ramp,
          prev.ramp,
          cur.ramp,
          out,
          (dir) => (dir > 0 ? 'Cargo ramp opening' : 'Cargo ramp closing'),
          (open) => (open ? 'Cargo ramp open' : 'Cargo ramp closed')
        );
        // Flaps: once they reach the lever's detent (one notice for a multi-detent move).
        if (cur.flapPos >= 0) {
          const settled = Math.abs(cur.flapPos - cur.flapLever) <= FLAP_SETTLED_EPS;
          if (!settled) flapsAt = -1;
          else if (flapsAt !== cur.flapLever) {
            flapsAt = cur.flapLever;
            // SLATS from UP is reported by the slats themselves (they take their own time); from
            // further down, the flaps have come up to it.
            if (flapDetentName(profile.flapNames, cur.flapLever) !== 'SLATS') out.push(flapNotice(profile.flapNames, cur.flapLever));
            else if (lastSettled > cur.flapLever) out.push('Flaps up, slats out');
            lastSettled = cur.flapLever;
          }
          if (!slatsOut && cur.slats >= 1 - END_EPS) {
            slatsOut = true;
            out.push('Slats extended');
          } else if (slatsOut && cur.slats <= END_EPS) {
            slatsOut = false;
            out.push('Slats retracted');
          }
        }
      }
      prev = cur;
      return out;
    },
  };
}
