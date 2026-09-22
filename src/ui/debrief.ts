/**
 * src/ui/debrief.ts — implements CreateDebriefScreen (docs/spec/11-ui.md
 * section 4.4). Displays objectivesCompleted/objectivesTotal as a fraction
 * and per-weapon accuracy with a max(1, fired) guard so 0 shots fired never
 * renders 0/0 (NaN) — display-only arithmetic, never written back anywhere.
 */
import type { CreateDebriefScreen, DebriefStats } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { el, actionButton } from './domHelpers';

function accuracyPct(hit: number, fired: number): string {
  const pct = (hit / Math.max(1, fired)) * 100;
  return `${pct.toFixed(0)}%`;
}

export const createDebriefScreen: CreateDebriefScreen = (container, stats: DebriefStats, callbacks) => {
  const root = el('div', { className: 'tj-debrief' });
  const title = el('h2', { text: 'Mission Debrief' });
  const outcome = el('div', { className: `tj-debrief-outcome tj-debrief-outcome-${stats.outcome}`, text: `Outcome: ${stats.outcome}` });

  const statsList = el('ul', { className: 'tj-debrief-stats' });
  const addStat = (text: string): void => {
    statsList.appendChild(el('li', { text }));
  };
  addStat(`Duration: ${stats.durationSec.toFixed(0)}s`);
  addStat(`Kills: ${stats.kills}`);
  addStat(`Deaths: ${stats.deaths}`);
  addStat(`Objectives: ${stats.objectivesCompleted.length}/${stats.objectivesTotal}`);
  addStat(`Gun: ${stats.shotsHitGun}/${stats.shotsFiredGun} hits (${accuracyPct(stats.shotsHitGun, stats.shotsFiredGun)})`);
  addStat(`Missiles: ${stats.missilesHit}/${stats.missilesFired} hits (${accuracyPct(stats.missilesHit, stats.missilesFired)})`);

  const nav = el('div', { className: 'tj-debrief-nav' });
  const replayBtn = actionButton('replay', 'Replay');
  const missionSelectBtn = actionButton('mission-select', 'Mission Select');
  const mainMenuBtn = actionButton('main-menu', 'Main Menu');
  nav.append(replayBtn, missionSelectBtn, mainMenuBtn);

  root.append(title, outcome, statsList, nav);

  replayBtn.addEventListener('click', () => callbacks.onReplay());
  missionSelectBtn.addEventListener('click', () => callbacks.onMissionSelect());
  mainMenuBtn.addEventListener('click', () => callbacks.onMainMenu());

  return mountScreen(container, root);
};
