/**
 * src/ui/freeFlight.ts — Free Flight setup: base, how to start, time of day, weather, loadout.
 * The defaults (INS Hansa, runway, late morning, clear, the default loadout) make a good first
 * flight on their own; src/main.ts remembers the last setup.
 */
import type { WeatherMode } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { ScreenHandle } from '../contracts/ui';
import type { BaseId, BaseInfo, StartMode } from '../core/missions/catalogue';
import { UNTESTED_BADGE, UNTESTED_NOTE } from '../core/missions/catalogue';
import { mountScreen } from './screenHandle';
import { button, field, h, menuKeys, segmented, shell } from './kit';
import { createLoadoutEditor, describeFit, selectionFit, selectionName, type LoadoutSelection } from './loadoutEditor';
import { formatTimeOfDay } from './settings';

export interface FreeFlightSetup {
  baseId: BaseId;
  start: StartMode;
  timeOfDayH: number;
  weather: WeatherMode;
  loadout: LoadoutSelection;
}

export const DEFAULT_FREE_FLIGHT: FreeFlightSetup = { baseId: 'hansa', start: 'runway', timeOfDayH: 10.5, weather: 'clear', loadout: {} };

export const FREE_FLIGHT_WEATHER: readonly { value: WeatherMode; label: string }[] = [
  { value: 'clear', label: 'Clear' },
  { value: 'hazy', label: 'Hazy' },
  { value: 'fog', label: 'Fog' },
  { value: 'overcast', label: 'Overcast' },
  { value: 'rain', label: 'Rain' },
  { value: 'dynamic', label: 'Changing' },
];

export interface FreeFlightCallbacks {
  onFly(setup: FreeFlightSetup): void;
  onBack(): void;
}

export function createFreeFlightSetup(container: HTMLElement, opts: { bases: readonly BaseInfo[]; def: AircraftDefinition; setup: FreeFlightSetup }, cb: FreeFlightCallbacks): ScreenHandle {
  const setup: FreeFlightSetup = { ...opts.setup, loadout: { ...opts.setup.loadout } };
  const s = shell({ title: 'Free Flight', sub: 'Take off and fly. No enemies, no time limit.', back: { onClick: () => cb.onBack() } });
  s.root.classList.add('tj-free-flight');

  // Bases.
  const baseCards = opts.bases.map((b) => {
    const card = h(
      'button',
      { className: 'tj-card', attrs: { type: 'button', role: 'radio', 'aria-checked': String(b.id === setup.baseId), 'data-base': b.id } },
      h('span', { className: 'tj-card-title' }, h('span', { text: b.name }), b.untested ? h('span', { className: 'tj-badge tj-badge--warn', text: UNTESTED_BADGE }) : false),
      h('span', { className: 'tj-card-meta', text: b.place }),
      h('span', { text: b.blurb }),
      b.untested ? h('span', { className: 'tj-note tj-note--warn', text: UNTESTED_NOTE }) : false
    );
    card.addEventListener('click', () => {
      setup.baseId = b.id;
      for (const c of baseCards) c.setAttribute('aria-checked', String(c === card));
      renderStart();
    });
    return card;
  });
  const bases = h('div', { className: 'tj-stack', attrs: { role: 'radiogroup', 'aria-label': 'Base' } }, ...baseCards);

  // Start.
  const startHolder = h('div');
  const startNote = h('p', { className: 'tj-note' });
  function renderStart(): void {
    const base = opts.bases.find((b) => b.id === setup.baseId)!;
    const seg = segmented<StartMode>(
      'Start',
      [
        { value: 'parked', label: 'Parked' },
        { value: 'runway', label: 'Runway' },
        { value: 'air', label: 'In the air' },
      ],
      setup.start,
      (v) => {
        setup.start = v;
        noteFor(base);
      },
      { 'data-role': 'start' }
    );
    startHolder.replaceChildren(seg);
    noteFor(base);
  }
  function noteFor(base: BaseInfo): void {
    startNote.textContent =
      setup.start === 'parked'
        ? `Engine running, ${base.parkedLabel}. Press H for taxi guidance to the runway.`
        : setup.start === 'runway'
          ? 'Lined up on the runway in use, engine running. Throttle up (X) and go.'
          : '3,000 m above the field, 350 kt, on the approach. Gear up.';
  }
  renderStart();

  // Time of day.
  const timeValue = h('span', { className: 'tj-value', text: formatTimeOfDay(setup.timeOfDayH), attrs: { 'data-role': 'time-value' } });
  const time = h('input', { className: 'tj-range', attrs: { type: 'range', min: '0', max: '24', step: '0.25', 'data-role': 'time', 'aria-label': 'Time of day' } });
  time.value = String(setup.timeOfDayH);
  time.addEventListener('input', () => {
    setup.timeOfDayH = Number(time.value);
    timeValue.textContent = formatTimeOfDay(setup.timeOfDayH);
  });

  // Weather.
  const weather = segmented<WeatherMode>('Weather', FREE_FLIGHT_WEATHER, setup.weather, (v) => (setup.weather = v), { 'data-role': 'weather' });

  // Loadout.
  const loadoutName = h('b');
  const loadoutText = h('span', { className: 'tj-note' });
  function renderLoadout(): void {
    loadoutName.textContent = selectionName(opts.def, setup.loadout);
    loadoutText.textContent = describeFit(selectionFit(opts.def, setup.loadout));
  }
  renderLoadout();
  const changeLoadout = button('Change loadout…', () => openEditor(), 'default', { 'data-action': 'loadout' });

  s.body.append(
    h(
      'div',
      { className: 'tj-cols' },
      field('Base', bases),
      h('div', { className: 'tj-stack' }, field('Start', h('div', { className: 'tj-stack' }, startHolder, startNote)), field('Time of day', h('div', { className: 'tj-row' }, time, timeValue)), field('Weather', weather), field('Loadout', h('div', { className: 'tj-stack', attrs: { style: 'gap: 4px' } }, loadoutName, loadoutText, h('div', {}, changeLoadout))))
    )
  );
  s.actions.append(button('Fly', () => cb.onFly({ ...setup }), ['primary', 'big'], { 'data-action': 'fly' }));

  const handle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => cb.onBack());

  function openEditor(): void {
    s.root.classList.add('tj-hidden');
    const ed = createLoadoutEditor(container, opts.def, setup.loadout, {
      onDone: (sel) => {
        setup.loadout = sel;
        ed.destroy();
        s.root.classList.remove('tj-hidden');
        renderLoadout();
        changeLoadout.focus();
      },
      onCancel: () => {
        ed.destroy();
        s.root.classList.remove('tj-hidden');
        changeLoadout.focus();
      },
    });
  }

  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}
