// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountOrientationPrompt } from '../../src/ui/orientationPrompt';

interface FakeMql {
  matches: boolean;
  addEventListener: (type: string, cb: () => void) => void;
  removeEventListener: (type: string, cb: () => void) => void;
  fireChange: () => void;
}

function mockMatchMedia(initialPortraitMatches: boolean): FakeMql {
  const listeners: Array<() => void> = [];
  const fake: FakeMql = {
    matches: initialPortraitMatches,
    addEventListener: (_type, cb) => listeners.push(cb),
    removeEventListener: (_type, cb) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    fireChange: () => listeners.forEach((cb) => cb()),
  };
  window.matchMedia = vi.fn().mockReturnValue(fake) as unknown as typeof window.matchMedia;
  return fake;
}

function mockScreenSize(width: number, height: number): void {
  Object.defineProperty(window.screen, 'width', { value: width, configurable: true });
  Object.defineProperty(window.screen, 'height', { value: height, configurable: true });
}

describe('mountOrientationPrompt', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('shows the overlay when portrait and small (375x812)', () => {
    mockMatchMedia(true);
    mockScreenSize(375, 812);
    const handle = mountOrientationPrompt(container);
    expect(handle.rootEl.classList.contains('tj-hidden')).toBe(false);
    handle.destroy();
  });

  it('hides the overlay when landscape (812x375)', () => {
    mockMatchMedia(false);
    mockScreenSize(812, 375);
    const handle = mountOrientationPrompt(container);
    expect(handle.rootEl.classList.contains('tj-hidden')).toBe(true);
    handle.destroy();
  });

  it('never blocks pointer interaction underneath', () => {
    mockMatchMedia(true);
    mockScreenSize(375, 812);
    const handle = mountOrientationPrompt(container);
    expect(handle.rootEl.style.pointerEvents).toBe('none');
    handle.destroy();
  });

  it('destroy() removes the overlay element', () => {
    mockMatchMedia(true);
    mockScreenSize(375, 812);
    const handle = mountOrientationPrompt(container);
    handle.destroy();
    expect(container.contains(handle.rootEl)).toBe(false);
  });
});
