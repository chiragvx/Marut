/**
 * src/ui/pwa.ts — implements RegisterServiceWorker (docs/spec/11-ui.md
 * section 4.8). Never throws or rejects.
 */
import type { RegisterServiceWorker, ServiceWorkerRegistrationHandle } from '../contracts/ui';

export const registerServiceWorker: RegisterServiceWorker = async (swUrl) => {
  const updateCbs: Array<() => void> = [];

  if (!('serviceWorker' in navigator)) {
    return {
      registered: false,
      scope: undefined,
      error: 'serviceWorker unsupported',
      onUpdateAvailable: (cb: () => void): void => {
        updateCbs.push(cb);
      },
    };
  }

  try {
    const reg = await navigator.serviceWorker.register(swUrl);
    const hadController = navigator.serviceWorker.controller !== null;
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      if (installing === null) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && hadController) {
          for (const cb of updateCbs) cb();
        }
      });
    });
    return {
      registered: true,
      scope: reg.scope,
      error: undefined,
      onUpdateAvailable: (cb: () => void): void => {
        updateCbs.push(cb);
      },
    };
  } catch (e) {
    return {
      registered: false,
      scope: undefined,
      error: String(e),
      onUpdateAvailable: (cb: () => void): void => {
        updateCbs.push(cb);
      },
    };
  }
};
