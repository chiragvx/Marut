/**
 * src/ui/actionBar.ts — the on-screen buttons in flight (on by default; Settings -> Gameplay): a
 * column on the left edge with the controls people hunt for on the keyboard. Camera, the radar's
 * mode, range and target, weapon, flares and chaff, gear, airbrake and taxi guidance. Each button
 * shows its key and its state (GEAR DOWN, RWS, GUN...). Flight School lights up the button it is
 * asking for (highlight()).
 *
 * The buttons never take keyboard focus (Space fires the gun and Enter a missile, which would also
 * "click" a focused button), and a click does not reach the canvas (no pointer lock grab).
 */
import { h } from './kit';

export type ActionId = 'camera' | 'radarMode' | 'radarRangeDown' | 'radarRangeUp' | 'target' | 'weapon' | 'flare' | 'chaff' | 'gear' | 'airbrake' | 'taxi';

export interface ActionBarState {
  camera: string;
  radarMode: string;
  weapon: string;
  gear: string;
  airbrake: string;
  /** Show the taxi-guide button (on the ground only). */
  onGround: boolean;
}

export interface ActionBar {
  root: HTMLElement;
  setVisible(v: boolean): void;
  /** Screen width it takes from the left edge, CSS px (0 while hidden). */
  widthPx(): number;
  setKeys(keys: Partial<Record<ActionId, string>>): void;
  setState(s: ActionBarState): void;
  /** Buttons to light up (Flight School); empty for none. */
  highlight(ids: readonly ActionId[]): void;
  destroy(): void;
}

interface Def {
  id: ActionId;
  label: string;
  /** A small glyph (text), drawn in the icon box. */
  icon: string;
}

/** Two small buttons on one labelled row (Range - +, Decoys flare chaff). */
interface Row {
  row: string;
  items: readonly [Def, Def];
}

/** The groups, top to bottom. */
const GROUPS: readonly { title: string; items: readonly (Def | Row)[] }[] = [
  { title: 'View', items: [{ id: 'camera', label: 'Camera', icon: '◉' }] },
  {
    title: 'Radar',
    items: [
      { id: 'radarMode', label: 'Scan mode', icon: '◠' },
      {
        row: 'Range',
        items: [
          { id: 'radarRangeDown', label: 'Radar range down', icon: '−' },
          { id: 'radarRangeUp', label: 'Radar range up', icon: '+' },
        ],
      },
      { id: 'target', label: 'Target', icon: '⌖' },
    ],
  },
  {
    title: 'Weapons',
    items: [
      { id: 'weapon', label: 'Weapon', icon: '⇄' },
      {
        row: 'Decoys',
        items: [
          { id: 'flare', label: 'Flare', icon: '✶' },
          { id: 'chaff', label: 'Chaff', icon: '⁂' },
        ],
      },
    ],
  },
  {
    title: 'Jet',
    items: [
      { id: 'gear', label: 'Gear', icon: '⊥' },
      { id: 'airbrake', label: 'Airbrake', icon: '⫼' },
      { id: 'taxi', label: 'Taxi guide', icon: '↱' },
    ],
  },
];

export function createActionBar(container: HTMLElement, onAction: (id: ActionId) => void): ActionBar {
  const buttons = new Map<ActionId, { el: HTMLButtonElement; key: HTMLElement; state: HTMLElement | null }>();

  const make = (d: Def, compact: boolean): HTMLButtonElement => {
    const key = h('span', { className: 'tj-ab-key' });
    const state = compact ? null : h('span', { className: 'tj-ab-state' });
    const el = h(
      'button',
      { className: `tj-ab-btn${compact ? ' tj-ab-btn--half' : ''}`, attrs: { type: 'button', tabindex: '-1', 'data-action-id': d.id, title: d.label } },
      h('span', { className: 'tj-ab-icon', text: d.icon, attrs: { 'aria-hidden': 'true' } }),
      compact ? false : h('span', { className: 'tj-ab-text' }, h('span', { className: 'tj-ab-label', text: d.label }), ...(state ? [state] : [])),
      key
    ) as HTMLButtonElement;
    // No focus (Space / Enter are flight keys), and the click stays here (no pointer lock).
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.remove('tj-ab-btn--pressed');
      void el.offsetWidth;
      el.classList.add('tj-ab-btn--pressed');
      onAction(d.id);
    });
    buttons.set(d.id, { el, key, state });
    return el;
  };

  const groups = GROUPS.map((g) =>
    h(
      'div',
      { className: 'tj-ab-group', attrs: { role: 'group', 'aria-label': g.title } },
      h('div', { className: 'tj-ab-title', text: g.title }),
      ...g.items.map((it) =>
        'row' in it ? h('div', { className: 'tj-ab-pair' }, h('span', { className: 'tj-ab-rowlabel', text: it.row }), make(it.items[0], true), make(it.items[1], true)) : make(it, false)
      )
    )
  );
  const root = h('div', { className: 'tj-actionbar tj-hidden', attrs: { 'data-role': 'action-bar' } }, ...groups);
  container.appendChild(root);
  let lit = '';
  let stateKey = '';
  let width = -1;
  let measuredFor = '';

  return {
    root,
    setVisible(v) {
      root.classList.toggle('tj-hidden', !v);
    },
    widthPx() {
      if (root.classList.contains('tj-hidden')) return 0;
      // Measured once per window size (a layout read every frame would cost).
      const key = `${window.innerWidth}x${window.innerHeight}`;
      if (key !== measuredFor || width < 0) {
        const r = root.getBoundingClientRect();
        if (r.width > 0) {
          width = Math.ceil(r.right) + 8;
          measuredFor = key;
        }
      }
      return Math.max(0, width);
    },
    setKeys(keys) {
      for (const [id, b] of buttons) b.key.textContent = keys[id] ?? '';
    },
    setState(s) {
      const k = `${s.camera}|${s.radarMode}|${s.weapon}|${s.gear}|${s.airbrake}|${s.onGround}`;
      if (k === stateKey) return;
      stateKey = k;
      const set = (id: ActionId, text: string): void => {
        const b = buttons.get(id);
        if (b?.state) b.state.textContent = text;
      };
      set('camera', s.camera);
      set('radarMode', s.radarMode);
      set('weapon', s.weapon);
      set('gear', s.gear);
      set('airbrake', s.airbrake);
      set('target', '');
      set('taxi', s.onGround ? '' : 'on the ground');
      buttons.get('gear')?.el.classList.toggle('tj-ab-btn--on', s.gear === 'DOWN');
      buttons.get('airbrake')?.el.classList.toggle('tj-ab-btn--on', s.airbrake === 'OUT');
      buttons.get('taxi')?.el.classList.toggle('tj-ab-btn--dim', !s.onGround);
    },
    highlight(ids) {
      const k = ids.join(',');
      if (k === lit) return;
      lit = k;
      for (const [id, b] of buttons) b.el.classList.toggle('tj-ab-btn--lit', ids.includes(id));
    },
    destroy() {
      root.remove();
    },
  };
}
