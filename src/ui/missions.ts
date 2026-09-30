/**
 * src/ui/missions.ts — the mission list and the briefing.
 *
 * List: one card per mission (base, bandits, one-line objective, and whether it has been flown,
 * with the best time); choosing one opens its briefing. Briefing: situation, objective, the keys to
 * lock and fire (missiles launch only on a lock), difficulty and loadout, then Start.
 */
import type { AiDifficulty } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { ScreenHandle } from '../contracts/ui';
import type { BaseInfo, MissionEntry } from '../core/missions/catalogue';
import { UNTESTED_BADGE, UNTESTED_NOTE } from '../core/missions/catalogue';
import { mountScreen } from './screenHandle';
import { button, field, h, keyCap, menuKeys, segmented, shell } from './kit';
import { createLoadoutEditor, describeFit, fitSummary, selectionFit, selectionName, type LoadoutSelection } from './loadoutEditor';

export interface MissionProgress {
  completed: boolean;
  bestSec?: number;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createMissionList(
  container: HTMLElement,
  opts: { missions: readonly MissionEntry[]; bases: readonly BaseInfo[]; progress: Readonly<Record<string, MissionProgress>> },
  cb: { onSelect(id: string): void; onBack(): void }
): ScreenHandle {
  const s = shell({ title: 'Missions', sub: 'Air-to-air. Each one starts at a base; the enemy is already on its way.', back: { onClick: () => cb.onBack() } });
  s.root.classList.add('tj-missions');
  const cards = opts.missions.map((m) => {
    const base = opts.bases.find((b) => b.id === m.baseId);
    const p = opts.progress[m.id];
    const status = p?.completed ? h('span', { className: 'tj-badge tj-badge--ok', text: p.bestSec !== undefined ? `Done · ${formatDuration(p.bestSec)}` : 'Done' }) : h('span', { className: 'tj-badge', text: 'Not flown' });
    const card = h(
      'button',
      { className: 'tj-card', attrs: { type: 'button', 'data-mission': m.id } },
      h('span', { className: 'tj-card-title' }, h('span', { text: m.title }), status),
      h('span', { className: 'tj-card-meta', text: `${base?.name ?? ''} · ${m.targets !== undefined ? `${m.targets} ground targets` : `${m.bandits} bandit${m.bandits === 1 ? '' : 's'}`}` }, base?.untested ? h('span', { className: 'tj-badge tj-badge--warn tj-badge--inline', text: UNTESTED_BADGE }) : false),
      h('span', { text: m.objective }),
      m.recommended ? h('span', { className: 'tj-label', text: 'Fly this one first' }) : false
    );
    card.addEventListener('click', () => cb.onSelect(m.id));
    return card;
  });
  s.body.append(h('div', { className: 'tj-cards' }, ...cards), h('p', { className: 'tj-note', text: 'More missions in later versions.' }));
  const handle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => cb.onBack(), { initialFocus: cards[0] });
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}

export interface BriefingKeys {
  target: string;
  launch: string;
  weapon: string;
  gun: string;
}

export function createBriefing(
  container: HTMLElement,
  opts: { entry: MissionEntry; base: BaseInfo | undefined; index: number; def: AircraftDefinition; difficulty: AiDifficulty; loadout: LoadoutSelection; keys: BriefingKeys },
  cb: { onStart(difficulty: AiDifficulty, loadout: LoadoutSelection): void; onBack(): void }
): ScreenHandle {
  let difficulty = opts.difficulty;
  let loadout = opts.loadout;
  const m = opts.entry;
  const s = shell({ title: m.title, eyebrow: `Mission ${opts.index + 1} · ${opts.base?.name ?? ''}`, back: { label: 'Missions', onClick: () => cb.onBack() } });
  s.root.classList.add('tj-briefing');

  const k = opts.keys;
  const howTo = h(
    'div',
    { className: 'tj-stack', attrs: { style: 'gap: 6px' } },
    h('div', { className: 'tj-row' }, keyCap(k.target), h('span', { text: 'designate the next target' })),
    h('div', { className: 'tj-row' }, h('span', { text: 'wait for LOCK on the HUD, then' }), keyCap(k.launch), h('span', { text: 'to fire a missile' })),
    h('div', { className: 'tj-row' }, keyCap(k.weapon), h('span', { text: 'switch weapon' }), keyCap(k.gun), h('span', { text: 'gun (hold)' }))
  );

  const loadoutName = h('b');
  const loadoutText = h('span', {});
  const loadoutSummary = h('span', { className: 'tj-note' });
  function renderLoadout(): void {
    const fit = selectionFit(opts.def, loadout);
    loadoutName.textContent = selectionName(opts.def, loadout);
    loadoutText.textContent = describeFit(fit);
    loadoutSummary.textContent = fitSummary(opts.def, fit);
  }
  renderLoadout();
  const change = button('Change loadout…', () => openEditor(), 'default', { 'data-action': 'loadout' });

  if (opts.base?.untested) s.body.append(h('p', { className: 'tj-note tj-note--warn', text: UNTESTED_NOTE, attrs: { 'data-role': 'untested' } }));
  s.body.append(
    h(
      'div',
      { className: 'tj-cols' },
      h('div', { className: 'tj-stack' }, field('Situation', h('p', { text: m.situation, attrs: { style: 'margin:0' } })), field('Objective', h('p', { text: m.objective, attrs: { style: 'margin:0' } })), field('How to fight', howTo)),
      h(
        'div',
        { className: 'tj-stack' },
        field(
          'Difficulty',
          segmented<AiDifficulty>(
            'Difficulty',
            [
              { value: 'rookie', label: 'Rookie' },
              { value: 'veteran', label: 'Veteran' },
              { value: 'ace', label: 'Ace' },
            ],
            difficulty,
            (v) => (difficulty = v),
            { 'data-role': 'difficulty' }
          ),
          'How well the enemy flies and fights.'
        ),
        field('Loadout', h('div', { className: 'tj-stack', attrs: { style: 'gap: 4px' } }, loadoutName, loadoutText, loadoutSummary, h('div', {}, change)))
      )
    )
  );
  s.actions.append(button('Start mission', () => cb.onStart(difficulty, loadout), ['primary', 'big'], { 'data-action': 'start' }));

  const handle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => cb.onBack());

  function openEditor(): void {
    s.root.classList.add('tj-hidden');
    const ed = createLoadoutEditor(container, opts.def, loadout, {
      onDone: (sel) => {
        loadout = sel;
        ed.destroy();
        s.root.classList.remove('tj-hidden');
        renderLoadout();
        change.focus();
      },
      onCancel: () => {
        ed.destroy();
        s.root.classList.remove('tj-hidden');
        change.focus();
      },
    });
  }

  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}
