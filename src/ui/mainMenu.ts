/**
 * src/ui/mainMenu.ts — implements CreateMainMenu (docs/spec/11-ui.md section 4.4).
 */
import type { CreateMainMenu } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { el, actionButton } from './domHelpers';

export const createMainMenu: CreateMainMenu = (container, callbacks) => {
  const root = el('div', { className: 'tj-main-menu' });
  const title = el('h1', { className: 'tj-main-menu-title', text: 'HAL Tejas Mk1 — Flight Simulator' });

  const nav = el('div', { className: 'tj-main-menu-nav' });
  const playBtn = actionButton('play', 'Play');
  const editorBtn = actionButton('airport-editor', 'Airport Editor');
  const settingsBtn = actionButton('settings', 'Settings');
  nav.append(playBtn, editorBtn, settingsBtn);

  root.append(title, nav);

  playBtn.addEventListener('click', () => callbacks.onPlay());
  editorBtn.addEventListener('click', () => callbacks.onAirportEditor());
  settingsBtn.addEventListener('click', () => callbacks.onSettings());

  return mountScreen(container, root);
};
