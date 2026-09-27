/**
 * src/ui/mainMenu.ts — the title screen: Continue (the last flight's setup, once there is one),
 * Free Flight, Missions, Settings, Controls; feedback link, version and graphics quality below.
 */
import type { CreateMainMenu } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { button, externalLink, h, menuKeys } from './kit';
import { GAME_NAME, GAME_VERSION } from './links';

export const createMainMenu: CreateMainMenu = (container, options, callbacks) => {
  const menu = h('div', { className: 'tj-menu' });
  if (options.continueLabel && callbacks.onContinue) {
    const onContinue = callbacks.onContinue;
    menu.append(button(h('span', {}, h('span', { className: 'tj-label', text: 'Continue' }), h('div', { text: options.continueLabel })), () => onContinue(), ['block', 'primary'], { 'data-action': 'continue' }));
  }
  const first = options.continueLabel ? 'block' : (['block', 'primary'] as const);
  menu.append(
    button('Free Flight', () => callbacks.onFreeFlight(), first === 'block' ? 'block' : [...first], { 'data-action': 'free-flight' }),
    button(h('span', { className: 'tj-row', attrs: { style: 'justify-content: space-between; width: 100%' } }, h('span', { text: 'Missions' }), h('span', { className: 'tj-note', text: `${options.missionsDone} / ${options.missionsTotal} done` })), () => callbacks.onMissions(), 'block', { 'data-action': 'missions' }),
    button('Settings', () => callbacks.onSettings(), 'block', { 'data-action': 'settings' }),
    button('Controls', () => callbacks.onControls(), 'block', { 'data-action': 'controls' })
  );

  const panel = h(
    'div',
    { className: 'tj-panel', attrs: { style: 'width: min(560px, 100%)' } },
    h('div', { className: 'tj-head' }, h('div', { className: 'tj-eyebrow', text: `v${GAME_VERSION} · early access` }), h('h1', { className: 'tj-title', text: GAME_NAME }), h('p', { className: 'tj-sub', text: 'Combat flight over India, in your browser.' })),
    menu,
    h('div', { className: 'tj-foot' }, externalLink('Give feedback', options.feedbackUrl, 'Feedback (coming soon)'), h('span', { className: 'tj-note', text: `Graphics: ${options.qualityLabel}` }))
  );
  const root = h('div', { className: 'tj-screen tj-main-menu' }, panel);
  const handle = mountScreen(container, root);
  const release = menuKeys(root);
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
};
