/**
 * src/ui/orientationPrompt.ts — implements MountOrientationPrompt
 * (docs/spec/11-ui.md section 4.4). Visible exactly when the device is
 * portrait AND small (max(screen.width,screen.height) <= MOBILE_MAX_DIMENSION_PX),
 * re-evaluated on the matchMedia list's `change` event and on window resize.
 * Advisory only: pointer-events are disabled on the overlay so it never
 * blocks interaction with whatever is underneath it.
 */
import type { MountOrientationPrompt, OrientationPromptHandle } from '../contracts/ui';
import { MOBILE_MAX_DIMENSION_PX } from '../contracts/ui';
import { el } from './domHelpers';

export const mountOrientationPrompt: MountOrientationPrompt = (container): OrientationPromptHandle => {
  const rootEl = el('div', { className: 'tj-orientation-prompt tj-hidden' });
  rootEl.style.position = 'fixed';
  rootEl.style.inset = '0';
  rootEl.style.pointerEvents = 'none';
  const message = el('div', {
    className: 'tj-orientation-prompt-message',
    text: 'Rotate your device to landscape for the best experience.',
  });
  rootEl.appendChild(message);
  container.appendChild(rootEl);

  const portraitQuery = window.matchMedia('(orientation: portrait)');

  function evaluate(): void {
    const isPortrait = portraitQuery.matches;
    const maxDim = Math.max(window.screen.width, window.screen.height);
    const shouldShow = isPortrait && maxDim <= MOBILE_MAX_DIMENSION_PX;
    rootEl.classList.toggle('tj-hidden', !shouldShow);
  }

  const onChange = (): void => evaluate();
  portraitQuery.addEventListener('change', onChange);
  window.addEventListener('resize', onChange);

  evaluate();

  let destroyed = false;
  return {
    rootEl,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      portraitQuery.removeEventListener('change', onChange);
      window.removeEventListener('resize', onChange);
      rootEl.remove();
    },
  };
};
