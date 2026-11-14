/**
 * src/ui/toasts.ts — small, unobtrusive text notices (top centre, under the heading tape and the
 * autopilot status): each fades out after ~2.5 s, several stack (newest at the bottom), and the
 * same text again restarts its own notice rather than stacking a copy. Takes no pointer input.
 *
 * Generic: any aircraft's system notices (src/ui/systemNotices.ts) or anything else short.
 */
import { h } from './kit';

export interface ToastStack {
  root: HTMLElement;
  show(text: string): void;
  clear(): void;
  destroy(): void;
}

/** How long a notice stays, ms (then a short fade, in ui.css). */
export const TOAST_MS = 2500;
const FADE_MS = 300;
const MAX_TOASTS = 4;

export function createToastStack(container: HTMLElement, opts: { holdMs?: number; max?: number } = {}): ToastStack {
  const holdMs = opts.holdMs ?? TOAST_MS;
  const max = opts.max ?? MAX_TOASTS;
  const root = h('div', { className: 'tj-sys-toasts', attrs: { 'aria-live': 'polite', 'data-role': 'system-toasts' } });
  container.appendChild(root);
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  const drop = (el: HTMLElement): void => {
    const t = timers.get(el);
    if (t) clearTimeout(t);
    timers.delete(el);
    el.remove();
  };
  const arm = (el: HTMLElement): void => {
    const t = timers.get(el);
    if (t) clearTimeout(t);
    el.classList.remove('tj-sys-toast--out');
    timers.set(
      el,
      setTimeout(() => {
        el.classList.add('tj-sys-toast--out');
        timers.set(el, setTimeout(() => drop(el), FADE_MS));
      }, holdMs)
    );
  };

  return {
    root,
    show(text) {
      for (const el of Array.from(root.children) as HTMLElement[]) {
        if (el.textContent === text) {
          // Seen again: to the bottom of the stack, its time restarted.
          root.appendChild(el);
          arm(el);
          return;
        }
      }
      const el = h('div', { className: 'tj-sys-toast', text });
      root.appendChild(el);
      arm(el);
      while (root.childElementCount > max) drop(root.firstElementChild as HTMLElement);
    },
    clear() {
      for (const el of Array.from(root.children) as HTMLElement[]) drop(el);
    },
    destroy() {
      this.clear();
      root.remove();
    },
  };
}
