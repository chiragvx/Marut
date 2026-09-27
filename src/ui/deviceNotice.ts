/**
 * src/ui/deviceNotice.ts — shown once to phones and tablets: this is a desktop keyboard game; touch
 * controls exist but are experimental. "Try anyway" carries on to the main menu.
 */
import type { ScreenHandle } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { button, h, menuKeys } from './kit';

/** A touch-first device with no fine pointer (a phone or tablet). */
export function isTouchFirstDevice(): boolean {
  if (typeof matchMedia === 'undefined') return false;
  return matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;
}

export function createDeviceNotice(container: HTMLElement, cb: { onContinue(): void }): ScreenHandle {
  const panel = h(
    'div',
    { className: 'tj-panel tj-panel--narrow' },
    h('div', { className: 'tj-head' }, h('h1', { className: 'tj-title', text: 'Best on a desktop' }), h('p', { className: 'tj-sub', text: 'This game is made for a computer with a keyboard. Touch controls work but are experimental, and the menus are not built for touch yet.' })),
    h('div', { className: 'tj-foot' }, h('span'), h('div', { className: 'tj-foot-actions' }, button('Try anyway', () => cb.onContinue(), 'primary', { 'data-action': 'continue' })))
  );
  const root = h('div', { className: 'tj-screen tj-device-notice' }, panel);
  const handle = mountScreen(container, root);
  const release = menuKeys(root);
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}
