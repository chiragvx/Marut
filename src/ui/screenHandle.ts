/**
 * src/ui/screenHandle.ts — shared mount/show/hide/destroy pattern used by
 * every `CreateX` screen factory. See docs/spec/11-ui.md section 4.1.
 * Not exported from contracts/ui.ts; internal implementation detail.
 */
import type { ScreenHandle } from '../contracts/ui';

export function mountScreen(container: HTMLElement, rootEl: HTMLElement): ScreenHandle {
  rootEl.classList.add('tj-screen');
  container.appendChild(rootEl);
  let destroyed = false;
  return {
    rootEl,
    show(): void {
      rootEl.classList.remove('tj-hidden');
    },
    hide(): void {
      rootEl.classList.add('tj-hidden');
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      rootEl.replaceChildren(); // drop all listeners attached to descendants
      rootEl.remove();
    },
  };
}
