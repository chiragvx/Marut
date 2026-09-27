/**
 * src/ui/controls.ts — every key, grouped by what the player is trying to do. Built from the live
 * key map (src/main.ts passes the groups), so a rebound key shows here as bound. Opens from the
 * main menu, the pause menu and F1 in flight.
 */
import type { ScreenHandle } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { h, keyCap, menuKeys, shell } from './kit';

export interface ControlRow {
  /** Key labels (already human-readable), shown joined. */
  keys: readonly string[];
  label: string;
}

export interface ControlGroup {
  title: string;
  rows: readonly ControlRow[];
}

export function createControlsScreen(container: HTMLElement, groups: readonly ControlGroup[], cb: { onBack(): void; backLabel?: string }): ScreenHandle {
  const s = shell({ title: 'Controls', sub: 'Keyboard. Change any key in Settings → Controls.', back: { label: cb.backLabel ?? 'Back', onClick: () => cb.onBack() } });
  s.root.classList.add('tj-controls');
  s.body.append(
    h(
      'div',
      { className: 'tj-keygroups' },
      ...groups.map((g) =>
        h(
          'div',
          { className: 'tj-keygroup' },
          h('h3', { text: g.title }),
          h('div', { className: 'tj-keylist' }, ...g.rows.map((r) => h('div', { className: 'tj-keyrow' }, h('span', { text: r.label }), h('span', { className: 'tj-row', attrs: { style: 'gap: 4px' } }, ...r.keys.map(keyCap)))))
        )
      )
    )
  );
  const handle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => cb.onBack());
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}
