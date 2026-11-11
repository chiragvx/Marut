/**
 * src/ui/mainMenu.ts — the title screen, over the cinematic (src/ui/showcase.ts): the wordmark,
 * then Continue (the last flight's setup, once there is one), Free Flight, Missions, Settings,
 * Controls as a numbered list; feedback link, graphics quality and version along the bottom. The
 * letterbox bars and the shot's caption are styled in src/ui/ui.css (.tj-main-menu, .tj-shot-caption).
 */
import type { CreateMainMenu } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { button, externalLink, h, menuKeys } from './kit';
import { GAME_NAME, GAME_VERSION } from './links';

/** A menu entry's face: its number, its label (and an optional note on the right), a chevron. */
function item(n: number, label: string, note?: string): HTMLElement {
  return h(
    'span',
    { className: 'tj-mm-item' },
    h('span', { className: 'tj-mm-num', text: String(n).padStart(2, '0') }),
    h('span', { className: 'tj-mm-label', text: label }),
    ...(note ? [h('span', { className: 'tj-mm-note', text: note })] : []),
    h('span', { className: 'tj-mm-chev', text: '›', attrs: { 'aria-hidden': 'true' } })
  );
}

export const createMainMenu: CreateMainMenu = (container, options, callbacks) => {
  const menu = h('nav', { className: 'tj-menu tj-mm-menu', attrs: { 'aria-label': 'Main menu' } });
  let n = 1;
  if (options.continueLabel && callbacks.onContinue) {
    const onContinue = callbacks.onContinue;
    const face = h('span', { className: 'tj-mm-item tj-mm-item--continue' }, h('span', { className: 'tj-mm-num', text: String(n++).padStart(2, '0') }), h('span', { className: 'tj-mm-stack' }, h('span', { className: 'tj-mm-label', text: 'Continue' }), h('span', { className: 'tj-mm-sub', text: options.continueLabel })), h('span', { className: 'tj-mm-chev', text: '›', attrs: { 'aria-hidden': 'true' } }));
    menu.append(button(face, () => onContinue(), ['block', 'primary'], { 'data-action': 'continue' }));
  }
  const first = options.continueLabel ? 'block' : (['block', 'primary'] as const);
  menu.append(
    button(item(n++, 'Free Flight'), () => callbacks.onFreeFlight(), first === 'block' ? 'block' : [...first], { 'data-action': 'free-flight' }),
    button(item(n++, 'Missions', `${options.missionsDone} / ${options.missionsTotal}`), () => callbacks.onMissions(), 'block', { 'data-action': 'missions' }),
    button(item(n++, 'Settings'), () => callbacks.onSettings(), 'block', { 'data-action': 'settings' }),
    button(item(n++, 'Controls'), () => callbacks.onControls(), 'block', { 'data-action': 'controls' })
  );

  const brand = h(
    'header',
    { className: 'tj-mm-brand' },
    h('div', { className: 'tj-mm-kicker', text: 'HAL Tejas Mk1A · Indian Air Force' }),
    h('h1', { className: 'tj-mm-title', text: GAME_NAME }),
    h('p', { className: 'tj-mm-tag', text: 'Combat flight over India, in your browser.' })
  );
  const foot = h(
    'footer',
    { className: 'tj-mm-foot' },
    externalLink('Give feedback', options.feedbackUrl, 'Feedback (coming soon)'),
    h('span', { className: 'tj-mm-meta', text: `Graphics ${options.qualityLabel}` }),
    h('span', { className: 'tj-mm-meta', text: `v${GAME_VERSION} · Early access` })
  );
  const root = h('div', { className: 'tj-screen tj-main-menu' }, h('div', { className: 'tj-mm' }, brand, menu, foot));
  const handle = mountScreen(container, root);
  const release = menuKeys(root);
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
};
