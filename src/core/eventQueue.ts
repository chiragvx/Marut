/**
 * src/core/eventQueue.ts — implements `EventQueue`/`CreateEventQueue`
 * (contracts/sim.ts section 4). Capacity-bounded, allocation-free-after-
 * construction: the backing array is pre-sized once; `push` beyond capacity
 * is dropped.
 */

import type { SimEvent } from '../contracts/core';
import type { CreateEventQueue, EventQueue } from '../contracts/sim';

class EventQueueImpl implements EventQueue {
  readonly capacity: number;
  private buf: (SimEvent | undefined)[];
  private len = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Array<SimEvent | undefined>(capacity).fill(undefined);
  }

  get length(): number {
    return this.len;
  }

  push(event: SimEvent): boolean {
    if (this.len === this.capacity) return false;
    this.buf[this.len] = event;
    this.len += 1;
    return true;
  }

  drainInto(out: SimEvent[]): number {
    const n = this.len;
    for (let i = 0; i < n; i++) {
      // buf[i] is always defined for i < len by construction.
      out[i] = this.buf[i] as SimEvent;
    }
    this.len = 0;
    return n;
  }

  clear(): void {
    this.len = 0;
  }
}

export const createEventQueue: CreateEventQueue = (capacity: number) => new EventQueueImpl(capacity);
