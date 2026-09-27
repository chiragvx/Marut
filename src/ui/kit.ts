/**
 * src/ui/kit.ts — building blocks for the menu screens (styles in src/ui/ui.css): a DOM builder,
 * the screen shell (title, body, footer with Back and actions), buttons, segmented choices,
 * selects, key caps, and the menu keyboard handler.
 *
 * Menu keys: while a menu is open, `menuKeys` takes the keyboard before the flight controls do
 * (a capture listener on window). It moves focus with the arrow keys, lets Tab, Enter and Space do
 * their normal jobs on buttons and selects, and runs `onBack` on Escape. Without it the flight
 * controls' listener cancels the browser's default action for every bound key (Enter, Space, Tab,
 * Escape...), so menus could not be used from the keyboard. Only the most recently opened menu
 * handles keys.
 */

type Child = Node | string | false | null | undefined;

export interface HOpts {
  className?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
}

/** Creates an element with options and children (false/null/undefined children are skipped). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, opts: HOpts = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.text !== undefined) e.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
  if (opts.on) for (const [k, fn] of Object.entries(opts.on)) if (fn) e.addEventListener(k, fn);
  for (const c of children) if (c !== false && c !== null && c !== undefined) e.append(c);
  return e;
}

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'quiet' | 'block' | 'big';

export function button(label: string | Node, onClick: () => void, variant: ButtonVariant | ButtonVariant[] = 'default', attrs: Record<string, string> = {}): HTMLButtonElement {
  const vs = Array.isArray(variant) ? variant : [variant];
  const cls = ['tj-btn', ...vs.filter((v) => v !== 'default').map((v) => `tj-btn--${v}`)].join(' ');
  const b = h('button', { className: cls, attrs: { type: 'button', ...attrs } }, label);
  b.addEventListener('click', () => onClick());
  return b;
}

/** A link to an external page (new tab), or a greyed "coming soon" label when there is no URL yet. */
export function externalLink(label: string, url: string | undefined, soonLabel = `${label} (coming soon)`): HTMLElement {
  if (!url) return h('span', { className: 'tj-link tj-link--off', text: soonLabel, attrs: { 'aria-disabled': 'true' } });
  return h('a', { className: 'tj-link', text: `${label} ↗`, attrs: { href: url, target: '_blank', rel: 'noopener' } });
}

export interface Shell {
  root: HTMLDivElement;
  panel: HTMLDivElement;
  body: HTMLDivElement;
  foot: HTMLDivElement;
  actions: HTMLDivElement;
}

/** The standard menu layout: title block, body, footer (Back on the left, actions on the right). */
export function shell(o: { title: string; eyebrow?: string; sub?: string; back?: { label?: string; onClick: () => void }; narrow?: boolean; className?: string; clear?: boolean }): Shell {
  const body = h('div', { className: 'tj-body' });
  const actions = h('div', { className: 'tj-foot-actions' });
  const foot = h('div', { className: 'tj-foot' }, o.back ? button(`← ${o.back.label ?? 'Back'}`, o.back.onClick, 'default', { 'data-action': 'back' }) : false, actions);
  const panel = h(
    'div',
    { className: `tj-panel${o.narrow ? ' tj-panel--narrow' : ''}` },
    h('div', { className: 'tj-head' }, o.eyebrow ? h('div', { className: 'tj-eyebrow', text: o.eyebrow }) : false, h('h1', { className: 'tj-title', text: o.title }), o.sub ? h('p', { className: 'tj-sub', text: o.sub }) : false),
    body,
    foot
  );
  const root = h('div', { className: `tj-screen${o.clear ? ' tj-screen--clear' : ''}${o.className ? ' ' + o.className : ''}` }, panel);
  return { root, panel, body, foot, actions };
}

/** A one-of-several choice drawn as joined buttons (role=radiogroup). */
export function segmented<T extends string>(label: string, options: readonly { value: T; label: string }[], value: T, onChange: (v: T) => void, attrs: Record<string, string> = {}): HTMLDivElement {
  const group = h('div', { className: 'tj-seg', attrs: { role: 'radiogroup', 'aria-label': label, ...attrs } });
  const buttons = options.map((o) => {
    const b = h('button', { text: o.label, attrs: { type: 'button', role: 'radio', 'aria-checked': String(o.value === value), 'data-value': o.value } });
    b.addEventListener('click', () => {
      for (const x of buttons) x.setAttribute('aria-checked', String(x === b));
      onChange(o.value);
    });
    return b;
  });
  group.append(...buttons);
  return group;
}

export function select<T extends string>(options: readonly { value: T; label: string }[], value: T, onChange: (v: T) => void, attrs: Record<string, string> = {}): HTMLSelectElement {
  const s = h('select', { className: 'tj-select', attrs });
  for (const o of options) s.append(h('option', { text: o.label, attrs: { value: o.value } }));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

export function field(label: string, control: Node, note?: string): HTMLDivElement {
  return h('div', { className: 'tj-field' }, h('span', { className: 'tj-label', text: label }), control, note ? h('p', { className: 'tj-note', text: note }) : false);
}

/** A labelled settings row: label on the left, control on the right. */
export function row(label: string, control: Node): HTMLDivElement {
  return h('div', { className: 'tj-field-row' }, h('span', { text: label }), control);
}

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, attrs: Record<string, string> = {}): HTMLLabelElement {
  const input = h('input', { attrs: { type: 'checkbox', ...attrs } });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { className: 'tj-check' }, input, label);
}

export function keyCap(label: string): HTMLSpanElement {
  return h('span', { className: 'tj-key', text: label });
}

/** A KeyboardEvent.code as a player would name the key. */
export function keyLabel(code: string | null | undefined): string {
  if (!code) return '—';
  const named: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace',
    ShiftLeft: 'Shift', ShiftRight: 'Right Shift', ControlLeft: 'Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Alt', AltRight: 'Right Alt',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
    PageUp: 'Page Up', PageDown: 'Page Down', Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete',
  };
  if (named[code]) return named[code]!;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

// ---- Menu keyboard handling ------------------------------------------------------------------

interface MenuKeysEntry {
  root: HTMLElement;
  onBack?: () => void;
  isCapturing?: () => boolean;
}

const menuStack: MenuKeysEntry[] = [];
let listening = false;

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function onKey(e: KeyboardEvent): void {
  let top: MenuKeysEntry | undefined;
  for (let i = menuStack.length - 1; i >= 0 && !top; i--) if (menuStack[i]!.root.isConnected) top = menuStack[i];
  if (!top) return;
  if (top.isCapturing?.()) return; // a key rebind is waiting for this key
  const k = e.key;
  const active = document.activeElement as HTMLElement | null;
  const inTop = active !== null && top.root.contains(active);
  if (k === 'Escape') {
    e.stopImmediatePropagation();
    e.preventDefault();
    top.onBack?.();
    return;
  }
  const arrows = k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight';
  if (arrows) {
    const tag = active?.tagName;
    const type = (active as HTMLInputElement | null)?.type;
    // Selects and sliders use the arrows themselves.
    if (inTop && (tag === 'SELECT' || (tag === 'INPUT' && (type === 'range' || type === 'text' || type === 'number')))) {
      e.stopImmediatePropagation();
      return;
    }
    const items = Array.from(top.root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === active);
    if (items.length > 0) {
      const i = inTop && active ? items.indexOf(active) : -1;
      const back = k === 'ArrowUp' || k === 'ArrowLeft';
      const next = i < 0 ? 0 : (i + (back ? -1 : 1) + items.length) % items.length;
      items[next]!.focus();
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }
  // Everything else (Tab, Enter, Space, letters): the browser's normal behaviour, hidden from the
  // flight controls.
  e.stopImmediatePropagation();
}

/**
 * Gives a menu the keyboard until the returned function is called (or its root leaves the page).
 * Focuses `initialFocus`, or the first primary button, or the first control.
 */
export function menuKeys(root: HTMLElement, onBack?: () => void, opts: { initialFocus?: HTMLElement; isCapturing?: () => boolean } = {}): () => void {
  if (!listening) {
    window.addEventListener('keydown', onKey, { capture: true });
    listening = true;
  }
  const entry: MenuKeysEntry = { root, ...(onBack ? { onBack } : {}), ...(opts.isCapturing ? { isCapturing: opts.isCapturing } : {}) };
  // Drop menus whose screens were removed without releasing the keys.
  for (let i = menuStack.length - 1; i >= 0; i--) if (!menuStack[i]!.root.isConnected) menuStack.splice(i, 1);
  menuStack.push(entry);
  const first = opts.initialFocus ?? root.querySelector<HTMLElement>('.tj-btn--primary') ?? root.querySelector<HTMLElement>(FOCUSABLE);
  // After the screen is in the page.
  queueMicrotask(() => first?.focus({ preventScroll: true }));
  return () => {
    const i = menuStack.indexOf(entry);
    if (i >= 0) menuStack.splice(i, 1);
  };
}

/** True while any menu has the keyboard (for tests and the flight input). */
export function menuHasKeyboard(): boolean {
  return menuStack.some((m) => m.root.isConnected);
}
