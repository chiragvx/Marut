/**
 * src/ui/pauseMenu.ts — implements CreatePauseMenu (docs/spec/11-ui.md section 4.4).
 */
import type { CreatePauseMenu } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { el, actionButton } from './domHelpers';

export const createPauseMenu: CreatePauseMenu = (container, callbacks) => {
  const root = el('div', { className: 'tj-pause-menu' });
  const title = el('h2', { text: 'Paused' });

  const nav = el('div', { className: 'tj-pause-menu-nav' });
  const resumeBtn = actionButton('resume', 'Resume');
  const restartBtn = actionButton('restart', 'Restart');
  const settingsBtn = actionButton('open-settings', 'Settings');
  const quitBtn = actionButton('quit-to-menu', 'Quit to Menu');
  nav.append(resumeBtn, restartBtn, settingsBtn, quitBtn);

  root.append(title, nav);

  resumeBtn.addEventListener('click', () => callbacks.onResume());
  restartBtn.addEventListener('click', () => callbacks.onRestart());
  settingsBtn.addEventListener('click', () => callbacks.onOpenSettings());
  quitBtn.addEventListener('click', () => callbacks.onQuitToMenu());

  return mountScreen(container, root);
};
