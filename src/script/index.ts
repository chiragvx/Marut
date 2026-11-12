/**
 * src/script/index.ts — the scripted missions: a MissionScript (src/script/director.ts) for each
 * mission that has one.
 */
import type { Mission } from '../contracts/core';
import type { AirportLayout } from '../contracts/airport';
import type { MissionScript } from './director';
import { BorderDuelScript } from './missions/borderDuel';
import { BorderStrikeScript } from './missions/borderStrike';
import { DroneLesson, LandingLessonScript, TakeoffLesson, WeatherLandingLesson } from './missions/training';

export type { MissionScript, ScriptFrame, ObjectiveView, ScriptPrompt, PromptControl, ScriptOutcome } from './director';
export type { Transmission } from './radio';

export function createMissionScript(mission: Mission): MissionScript | undefined {
  const layouts = mission.world.airports as readonly AirportLayout[];
  switch (mission.id) {
    case 'border-duel':
      return new BorderDuelScript();
    case 'border-strike': {
      const s = mission.playerStart.pos ?? { x: 15000, y: 0, z: 2000 };
      return new BorderStrikeScript(layouts, { x: s.x, z: s.z });
    }
    case 'train-takeoff':
      return new TakeoffLesson();
    case 'train-landing':
      return new LandingLessonScript(layouts);
    case 'train-weather':
      return new WeatherLandingLesson(layouts);
    case 'train-drone':
      return new DroneLesson();
    default:
      return undefined;
  }
}
