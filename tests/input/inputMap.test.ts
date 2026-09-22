import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INPUT_MAP_DATA,
  parseInputMapData,
  serializeInputMapData,
  loadInputMap,
  detectDefaultControlScheme,
} from '../../src/input/inputMap';
import type { StorageLike, InputMapData } from '../../src/contracts/input';

function makeFakeStorage(initial: Record<string, string> = {}): StorageLike {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
  };
}

describe('parseInputMapData', () => {
  it('round-trips DEFAULT_INPUT_MAP_DATA', () => {
    const result = parseInputMapData(JSON.stringify(DEFAULT_INPUT_MAP_DATA));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(DEFAULT_INPUT_MAP_DATA);
    }
  });

  it('fails on malformed JSON', () => {
    const result = parseInputMapData('not json');
    expect(result.ok).toBe(false);
  });

  it('fails on a version mismatch', () => {
    const bad = { ...DEFAULT_INPUT_MAP_DATA, version: 999 };
    const result = parseInputMapData(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });
});

describe('serializeInputMapData', () => {
  it('round-trips through parseInputMapData', () => {
    const json = serializeInputMapData(DEFAULT_INPUT_MAP_DATA);
    const result = parseInputMapData(json);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(DEFAULT_INPUT_MAP_DATA);
  });
});

describe('loadInputMap', () => {
  it('falls back to a fresh clone of DEFAULT_INPUT_MAP_DATA when nothing is stored', () => {
    const storage = makeFakeStorage();
    const a = loadInputMap(storage);
    expect(a).toEqual(DEFAULT_INPUT_MAP_DATA);

    const b = loadInputMap(storage);
    (a as InputMapData).controlScheme = 'gamepad';
    expect(b.controlScheme).not.toBe('gamepad');
  });

  it('falls back to defaults without throwing on corrupted stored JSON', () => {
    const storage = makeFakeStorage({ 'tejas.inputMap.v1': '{not valid json' });
    expect(() => loadInputMap(storage)).not.toThrow();
    expect(loadInputMap(storage)).toEqual(DEFAULT_INPUT_MAP_DATA);
  });
});

describe('detectDefaultControlScheme', () => {
  it('picks touch on a touch device with no physical-keyboard hint', () => {
    expect(detectDefaultControlScheme({ maxTouchPoints: 5 }, false)).toBe('touch');
  });
  it('picks keyboardMouse when there are no touch points', () => {
    expect(detectDefaultControlScheme({ maxTouchPoints: 0 }, false)).toBe('keyboardMouse');
  });
  it('picks keyboardMouse on a touch device that also hints a physical keyboard', () => {
    expect(detectDefaultControlScheme({ maxTouchPoints: 5 }, true)).toBe('keyboardMouse');
  });
});
