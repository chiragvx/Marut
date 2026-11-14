/**
 * src/ui/freeFlight.ts — Free Flight setup: base, how to start, time of day, weather, loadout.
 * The defaults (Bhisiana, runway, late morning, clear, the default loadout) make a good first
 * flight on their own; src/main.ts remembers the last setup.
 */
import type { WeatherMode } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';
import type { ScreenHandle } from '../contracts/ui';
import type { BaseId, BaseInfo, StartMode } from '../core/missions/catalogue';
import type { FreeFlightAircraftId } from '../core/missions/catalogue';
import { FREE_FLIGHT_AIRCRAFT, LOCKED_NOTE, UNTESTED_BADGE, UNTESTED_NOTE, parkingSpotFor } from '../core/missions/catalogue';
import { mountScreen } from './screenHandle';
import { button, field, h, lockTag, menuKeys, segmented, shell } from './kit';
import { createLoadoutEditor, describeFit, selectionFit, selectionName, type LoadoutSelection, type LoadoutView } from './loadoutEditor';
import type { LoadoutFit } from '../aircraft/loadout';
import { formatTimeOfDay } from './settings';

export interface FreeFlightSetup {
  baseId: BaseId;
  start: StartMode;
  timeOfDayH: number;
  weather: WeatherMode;
  loadout: LoadoutSelection;
  /** Which aircraft (absent: the Tejas). */
  aircraftId?: FreeFlightAircraftId;
}

export const DEFAULT_FREE_FLIGHT: FreeFlightSetup = { baseId: 'bathinda', start: 'runway', timeOfDayH: 10.5, weather: 'clear', loadout: {} };

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

export function createFreeFlightSetup(container: HTMLElement, opts: { bases: readonly BaseInfo[]; def: AircraftDefinition; setup: FreeFlightSetup; /** The jet in its hangar, in 3D, while the loadout is edited (none: the editor alone). */ openLoadoutView?: (fit: LoadoutFit) => LoadoutView | undefined }, cb: FreeFlightCallbacks): ScreenHandle {
  const setup: FreeFlightSetup = { ...opts.setup, loadout: { ...opts.setup.loadout } };
  if (opts.bases.find((b) => b.id === setup.baseId)?.locked) setup.baseId = opts.bases.find((b) => !b.locked)?.id ?? setup.baseId;
  const s = shell({ title: 'Free Flight', eyebrow: 'Punjab · No enemies, no time limit', sub: 'Pick the hour, the weather and what hangs under the wings, then fly.', back: { onClick: () => cb.onBack() } });
  s.root.classList.add('tj-free-flight');

  // Bases (a locked one is shown, padlocked, and cannot be picked).
  const baseCards = opts.bases.map((b) => {
    if (b.locked) {
      return h(
        'div',
        { className: 'tj-card tj-locked', attrs: { 'data-base': b.id, 'aria-disabled': 'true', title: LOCKED_NOTE } },
        h('span', { className: 'tj-card-title' }, h('span', { text: b.name }), lockTag()),
        h('span', { className: 'tj-card-meta', text: b.place }),
        h('span', { text: b.blurb }),
        h('span', { className: 'tj-note', text: LOCKED_NOTE })
      );
    }
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
      for (const c of baseCards) if (c.getAttribute('role') === 'radio') c.setAttribute('aria-checked', String(c === card));
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
    // A transport parks on an apron stand: no Parked start where the base has none.
    const canPark = parkingSpotFor(base.id, setup.aircraftId) !== undefined;
    if (!canPark && setup.start === 'parked') setup.start = 'runway';
    const seg = segmented<StartMode>(
      'Start',
      [
        ...(canPark ? [{ value: 'parked' as const, label: 'Parked' }] : []),
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
    const transport = setup.aircraftId === 'c-17';
    startNote.textContent =
      setup.start === 'parked'
        ? `Engines running, ${transport ? 'on the apron' : base.parkedLabel}. Press H for taxi guidance to the runway.`
        : setup.start === 'air' && transport
          ? '3,000 m above the field, 230 kt, on the approach. Gear up.'
        : setup.start === 'runway'
          ? 'Lined up on the runway in use, engine running. Throttle up (X) and go.'
          : '3,000 m above the field, 350 kt, on the approach. Gear up.';
  }
  renderStart();

  // Aircraft.
  const aircraftNote = h('p', { className: 'tj-note' });
  const aircraft = segmented<FreeFlightAircraftId>(
    'Aircraft',
    FREE_FLIGHT_AIRCRAFT.map((a) => ({ value: a.id, label: a.label })),
    setup.aircraftId ?? 'tejas-mk1a',
    (v) => {
      setup.aircraftId = v;
      renderAircraft();
      renderStart();
    },
    { 'data-role': 'aircraft' }
  );

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
    loadoutText.textContent = describeFit(selectionFit(opts.def, setup.loadout)) + (setup.loadout.fuelFrac !== undefined && setup.loadout.fuelFrac < 1 ? ` · fuel ${Math.round(setup.loadout.fuelFrac * 100)}%` : '');
  }
  renderLoadout();
  const loadoutField = h('div', {});
  function renderAircraft(): void {
    const a = FREE_FLIGHT_AIRCRAFT.find((x) => x.id === (setup.aircraftId ?? 'tejas-mk1a'))!;
    aircraftNote.textContent = a.blurb;
    // The loadout editor is the Tejas's (the C-17 carries no stores).
    loadoutField.classList.toggle('tj-hidden', a.id !== 'tejas-mk1a');
  }
  const changeLoadout = button('Change loadout…', () => openEditor(), 'default', { 'data-action': 'loadout' });

  s.body.append(
    h(
      'div',
      { className: 'tj-cols' },
      field('Base', bases),
      h('div', { className: 'tj-stack' }, field('Aircraft', h('div', { className: 'tj-stack' }, aircraft, aircraftNote)), field('Start', h('div', { className: 'tj-stack' }, startHolder, startNote)), field('Time of day', h('div', { className: 'tj-row' }, time, timeValue)), field('Weather', weather), h('div', {}, loadoutField))
    )
  );
  loadoutField.append(field('Loadout', h('div', { className: 'tj-stack', attrs: { style: 'gap: 4px' } }, loadoutName, loadoutText, h('div', {}, changeLoadout))));
  renderAircraft();
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
    }, opts.openLoadoutView?.(selectionFit(opts.def, setup.loadout)));
  }

  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}
