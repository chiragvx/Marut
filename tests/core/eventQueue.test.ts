import { describe, expect, it } from 'vitest';
import { createEventQueue } from '../../src/core/eventQueue';
import type { SimEvent } from '../../src/contracts/core';
import { EVENT_QUEUE_CAPACITY } from '../../src/contracts/sim';

function warningEvent(entityId: number): SimEvent {
  return { type: 'warning', entityId, bit: 1, active: true };
}

describe('EventQueue', () => {
  it('push up to capacity, then drops', () => {
    const q = createEventQueue(EVENT_QUEUE_CAPACITY);
    for (let i = 0; i < EVENT_QUEUE_CAPACITY; i++) {
      expect(q.push(warningEvent(i))).toBe(true);
    }
    expect(q.length).toBe(EVENT_QUEUE_CAPACITY);
    expect(q.push(warningEvent(9999))).toBe(false);
    expect(q.length).toBe(EVENT_QUEUE_CAPACITY);
  });

  it('drainInto copies in push order and clears', () => {
    const q = createEventQueue(EVENT_QUEUE_CAPACITY);
    for (let i = 0; i < EVENT_QUEUE_CAPACITY; i++) q.push(warningEvent(i));
    const out: SimEvent[] = new Array(EVENT_QUEUE_CAPACITY);
    const n = q.drainInto(out);
    expect(n).toBe(EVENT_QUEUE_CAPACITY);
    for (let i = 0; i < EVENT_QUEUE_CAPACITY; i++) {
      expect((out[i] as { entityId: number }).entityId).toBe(i);
    }
    expect(q.length).toBe(0);
    const n2 = q.drainInto(out);
    expect(n2).toBe(0);
  });
});
