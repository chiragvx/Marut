/**
 * src/ui/debrief.ts — implements CreateDebriefScreen: the outcome in plain words, the numbers,
 * the objectives, a feedback prompt, and what to do next. The main action is Next mission after a
 * win and Fly again otherwise.
 */
import type { CreateDebriefScreen, DebriefStats } from '../contracts/ui';
import { MissionOutcome } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { button, externalLink, h, menuKeys } from './kit';
import { formatDuration } from './missions';

/** The headline for a result. */
export function outcomeTitle(stats: DebriefStats, freeFlight: boolean): string {
  if (stats.outcome === MissionOutcome.Success) return freeFlight ? 'Flight complete' : 'Mission complete';
  if (stats.outcome === MissionOutcome.Aborted) return freeFlight ? 'Flight ended' : 'Mission abandoned';
  if (stats.deaths > 0) return 'Shot down';
  return freeFlight ? 'Crashed' : 'Mission failed';
}

const pct = (hit: number, fired: number): string => (fired > 0 ? `${Math.round((100 * hit) / fired)}%` : '—');

export const createDebriefScreen: CreateDebriefScreen = (container, stats, callbacks, options = {}) => {
  const free = options.freeFlight === true;
  const won = stats.outcome === MissionOutcome.Success;
  const statTile = (label: string, value: string): HTMLElement => h('div', { className: 'tj-stat' }, h('span', { className: 'tj-label', text: label }), h('b', { text: value }));
  const tiles: (HTMLElement | false)[] = [
    statTile('Time', formatDuration(stats.durationSec)),
    free ? false : statTile('Kills', String(stats.kills)),
    stats.missilesFired > 0 ? statTile('Missiles hit', `${stats.missilesHit} / ${stats.missilesFired}`) : false,
    stats.shotsFiredGun > 0 ? statTile('Gun hits', pct(stats.shotsHitGun, stats.shotsFiredGun)) : false,
    options.newBest ? statTile('Best time', 'New') : false,
  ];

  const objectives = free
    ? false
    : h('div', { className: 'tj-stack', attrs: { style: 'gap: 4px' } }, h('span', { className: 'tj-label', text: 'Objectives' }), h('span', { text: `${stats.objectivesCompleted.length} of ${stats.objectivesTotal} complete${options.objectiveText ? ` · ${options.objectiveText}` : ''}` }));

  const next = won && callbacks.onNext ? button('Next mission', () => callbacks.onNext?.(), 'primary', { 'data-action': 'next' }) : false;
  const replay = button(free ? 'Fly again' : 'Fly again', () => callbacks.onReplay(), next ? 'default' : 'primary', { 'data-action': 'replay' });
  const panel = h(
    'div',
    { className: 'tj-panel', attrs: { style: 'width: min(720px, 100%)' } },
    h('div', { className: 'tj-head' }, h('div', { className: 'tj-eyebrow', text: options.title ?? '' }), h('h1', { className: 'tj-title', text: outcomeTitle(stats, free) })),
    h('div', { className: 'tj-stats' }, ...tiles),
    objectives,
    h('div', { className: 'tj-stack', attrs: { style: 'gap: 4px' } }, h('span', { className: 'tj-label', text: 'How was that flight?' }), h('span', {}, 'A couple of minutes of feedback helps a lot. ', externalLink('Give feedback', options.feedbackUrl, 'Feedback form coming soon'))),
    h(
      'div',
      { className: 'tj-foot' },
      button('Main menu', () => callbacks.onMainMenu(), 'default', { 'data-action': 'main-menu' }),
      h('div', { className: 'tj-foot-actions' }, free ? false : button('Missions', () => callbacks.onMissionSelect(), 'default', { 'data-action': 'mission-select' }), replay, next)
    )
  );
  const root = h('div', { className: 'tj-screen tj-debrief' }, panel);
  const handle = mountScreen(container, root);
  const release = menuKeys(root, () => callbacks.onMainMenu());
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
};
