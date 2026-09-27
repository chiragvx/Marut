/**
 * src/ui/loadingScreen.ts — implements CreateLoadingScreen: a progress bar with a status line and,
 * while a flight loads, the handful of keys a first-time pilot needs. `setReady` swaps the bar for
 * a Start button (focused, so Space or Enter starts): the flight waits, paused, until then.
 */
import type { CreateLoadingScreen } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { button, h, keyCap, menuKeys } from './kit';

export const createLoadingScreen: CreateLoadingScreen = (container, opts = {}) => {
  const bar = h('div');
  const progress = h('div', { className: 'tj-progress', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, bar);
  const message = h('p', { className: 'tj-note', text: 'Loading…', attrs: { 'data-role': 'message' } });
  const startSlot = h('div', { className: 'tj-row', attrs: { style: 'justify-content: center; min-height: 48px' } });
  const tips = opts.tips && opts.tips.length > 0
    ? h('div', { className: 'tj-stack' }, h('span', { className: 'tj-label', text: 'Your first keys' }), h('div', { className: 'tj-keylist' }, ...opts.tips.map(([keys, label]) => h('div', { className: 'tj-keyrow' }, h('span', { text: label }), h('span', { className: 'tj-row', attrs: { style: 'gap: 4px' } }, ...keys.map(keyCap))))))
    : false;
  const panel = h(
    'div',
    { className: 'tj-panel tj-panel--narrow' },
    h('div', { className: 'tj-head' }, opts.eyebrow ? h('div', { className: 'tj-eyebrow', text: opts.eyebrow }) : false, h('h1', { className: 'tj-title', text: opts.title ?? 'Loading' })),
    tips,
    h('div', { className: 'tj-stack' }, progress, message),
    startSlot
  );
  const root = h('div', { className: 'tj-screen tj-loading' }, panel);
  const handle = mountScreen(container, root);
  let release: (() => void) | undefined;
  return {
    ...handle,
    setProgress(fraction: number, msg?: string): void {
      const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
      bar.style.width = `${Math.round(f * 100)}%`;
      progress.setAttribute('aria-valuenow', String(Math.round(f * 100)));
      if (msg !== undefined) message.textContent = msg;
    },
    setReady(label: string, onStart: () => void): void {
      progress.classList.add('tj-hidden');
      message.textContent = 'Ready';
      const b = button(label, () => onStart(), ['primary', 'big'], { 'data-action': 'start' });
      startSlot.replaceChildren(b);
      release?.();
      release = menuKeys(root, undefined, { initialFocus: b });
    },
    destroy(): void {
      release?.();
      handle.destroy();
    },
  };
};
