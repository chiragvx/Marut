/**
 * src/ui/pauseMenu.ts — implements CreatePauseMenu: Resume, Restart flight, Controls, Settings,
 * feedback, Exit to menu. Restart and Exit ask first, inside the menu. Escape resumes (or
 * cancels an open question).
 */
import type { CreatePauseMenu } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { button, externalLink, h, menuKeys } from './kit';

export const createPauseMenu: CreatePauseMenu = (container, callbacks, options = {}) => {
  const list = h('div', { className: 'tj-menu' });
  const confirmSlot = h('div');
  const resume = button('Resume', () => callbacks.onResume(), ['block', 'primary'], { 'data-action': 'resume' });

  function ask(question: string, detail: string, yesLabel: string, onYes: () => void, from: HTMLElement): void {
    const no = button('Stay', () => close(), 'default', { 'data-action': 'confirm-no' });
    const box = h('div', { className: 'tj-confirm', attrs: { role: 'alertdialog', 'aria-label': question } }, h('b', { text: question }), h('span', { className: 'tj-note', text: detail }), h('div', { className: 'tj-row' }, no, button(yesLabel, onYes, 'primary', { 'data-action': 'confirm-yes' })));
    confirmSlot.replaceChildren(box);
    list.classList.add('tj-hidden');
    no.focus();
    function close(): void {
      confirmSlot.replaceChildren();
      list.classList.remove('tj-hidden');
      from.focus();
    }
    closeQuestion = close;
  }
  let closeQuestion: (() => void) | undefined;

  const restart = button('Restart flight', () => ask('Restart this flight?', 'You start again from the beginning.', 'Restart', () => callbacks.onRestart(), restart), 'block', { 'data-action': 'restart' });
  const exit = button('Exit to menu', () => ask('Exit this flight?', 'Progress in this flight is lost.', 'Exit to menu', () => callbacks.onQuitToMenu(), exit), 'block', { 'data-action': 'quit' });
  list.append(resume, restart);
  if (callbacks.onControls) list.append(button('Controls', () => callbacks.onControls?.(), 'block', { 'data-action': 'controls' }));
  list.append(button('Settings', () => callbacks.onOpenSettings(), 'block', { 'data-action': 'settings' }), exit);

  const panel = h(
    'div',
    { className: 'tj-panel', attrs: { style: 'width: min(460px, 100%)' } },
    h('div', { className: 'tj-head' }, h('h1', { className: 'tj-title', text: 'Paused' }), options.subtitle ? h('p', { className: 'tj-sub', text: options.subtitle }) : false),
    list,
    confirmSlot,
    h('div', { className: 'tj-foot' }, externalLink('Give feedback', options.feedbackUrl, 'Feedback (coming soon)'), h('span', { className: 'tj-note', text: 'Esc resumes' }))
  );
  const root = h('div', { className: 'tj-screen tj-pause' }, panel);
  const handle = mountScreen(container, root);
  const release = menuKeys(root, () => {
    if (closeQuestion && confirmSlot.childElementCount > 0) {
      closeQuestion();
      closeQuestion = undefined;
    } else callbacks.onResume();
  });
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
};
