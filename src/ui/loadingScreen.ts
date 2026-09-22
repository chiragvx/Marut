/**
 * src/ui/loadingScreen.ts — implements CreateLoadingScreen
 * (docs/spec/11-ui.md section 4.4).
 */
import type { CreateLoadingScreen, LoadingScreenHandle } from '../contracts/ui';
import { mountScreen } from './screenHandle';
import { el } from './domHelpers';

export const createLoadingScreen: CreateLoadingScreen = (container): LoadingScreenHandle => {
  const root = el('div', { className: 'tj-loading-screen' });
  const title = el('div', { className: 'tj-loading-title', text: 'Loading…' });
  const progress = el('progress', { className: 'tj-loading-progress' });
  progress.max = 1;
  progress.value = 0;
  const message = el('span', { className: 'tj-loading-message', attrs: { 'data-role': 'loading-message' } });

  root.append(title, progress, message);

  const handle = mountScreen(container, root);

  return {
    ...handle,
    setProgress(fraction: number, message_?: string): void {
      const clamped = Math.min(1, Math.max(0, fraction));
      progress.value = clamped;
      if (message_ !== undefined) message.textContent = message_;
    },
  };
};
