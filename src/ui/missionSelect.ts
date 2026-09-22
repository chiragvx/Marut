/**
 * src/ui/missionSelect.ts — implements CreateMissionSelect
 * (docs/spec/11-ui.md section 4.4).
 *
 * Each mission is one `<li data-mission-id="...">` with an inner
 * `data-action="launch"` button; activating it reads that row's
 * data-mission-id (the row containing the activated button) plus the
 * shared `<select data-action="difficulty">`'s CURRENT value (read at
 * click time, never captured at mount time).
 */
import type { AiDifficulty } from '../contracts/core';
import type { CreateMissionSelect, MissionSummary } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { el, actionButton } from './domHelpers';

const DIFFICULTY_VALUES: readonly AiDifficulty[] = ['rookie', 'veteran', 'ace'];

function buildRow(mission: MissionSummary): HTMLLIElement {
  const li = el('li', { className: 'tj-mission-row', attrs: { 'data-mission-id': mission.id } });
  const name = el('div', { className: 'tj-mission-name', text: mission.name });
  const aircraft = el('div', { className: 'tj-mission-aircraft', text: mission.aircraftLabel });
  const desc = el('p', { className: 'tj-mission-description', text: mission.description });
  const launchBtn = actionButton('launch', 'Launch');
  li.append(name, aircraft, desc, launchBtn);
  return li;
}

export const createMissionSelect: CreateMissionSelect = (container, options, callbacks) => {
  const root = el('div', { className: 'tj-mission-select' });
  const title = el('h2', { text: 'Mission Select' });

  const difficultyLabel = el('label', { className: 'tj-mission-difficulty-label', text: 'Difficulty' });
  const difficultySelect = el('select', { attrs: { 'data-action': 'difficulty' } });
  for (const d of DIFFICULTY_VALUES) {
    const opt = el('option', { text: d, attrs: { value: d } });
    difficultySelect.appendChild(opt);
  }
  difficultySelect.value = options.defaultDifficulty;
  difficultyLabel.appendChild(difficultySelect);

  const list = el('ul', { className: 'tj-mission-list' });
  for (const mission of options.missions) {
    list.appendChild(buildRow(mission));
  }

  const backBtn = actionButton('back', 'Back');

  root.append(title, difficultyLabel, list, backBtn);

  list.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const launchEl = target.closest('[data-action="launch"]');
    if (launchEl === null) return;
    const row = launchEl.closest<HTMLElement>('[data-mission-id]');
    if (row === null) return;
    const missionId = row.getAttribute('data-mission-id');
    if (missionId === null) return;
    callbacks.onLaunch(missionId, difficultySelect.value as AiDifficulty);
  });

  backBtn.addEventListener('click', () => callbacks.onBack());

  return mountScreen(container, root);
};
