/**
 * src/core/sim.worker.ts — worker bootstrap: owns `onmessage` for
 * `MainToSimMessage`, drives the timer + accumulator, owns the snapshot
 * buffer pool, posts `SimToMainMessage`. See 10-core-worker.md section 4.4
 * and 4.9 for the exact algorithm this file implements.
 *
 * This file (and ONLY this file, plus terrain.worker.ts) is compiled under
 * tsconfig.worker.json (lib: ES2022+WebWorker, no DOM) — see
 * 00-architecture.md section 13. `self`/`postMessage`/`setInterval` here are
 * therefore the WebWorker globals, not the DOM ones.
 */

import { SNAPSHOT_BUFFER_POOL_SIZE, SNAPSHOT_BYTES } from '../contracts/core';
import type {
  MainToSimMessage,
  SimEventsMessage,
  SimEvent,
  SimReadyMessage,
  SimSnapshotMessage,
} from '../contracts/core';
import { EVENT_QUEUE_CAPACITY } from '../contracts/sim';
import type { FixedStepAccumulatorState, World } from '../contracts/sim';
import { advanceFixedStep, shouldEmitSnapshot } from './fixedStepLoop';
import { createWorld } from './world';
import { buildWorldDependencies } from './missions/index';

let world: World | undefined;
let snapshotFreeBuffers: ArrayBuffer[] = [];
const eventScratch: SimEvent[] = new Array(EVENT_QUEUE_CAPACITY);
const accState: FixedStepAccumulatorState = { accumulatorSec: 0, tickCount: 0 };
let lastNowMs = 0;
let timerHandle: ReturnType<typeof setInterval> | undefined;

function emitSnapshotIfBufferAvailable(): void {
  if (!world) return;
  if (snapshotFreeBuffers.length === 0) return; // per 00-architecture.md section 5: skip, never allocate
  const buffer = snapshotFreeBuffers.pop() as ArrayBuffer;
  const view = new Float64Array(buffer);
  world.writeSnapshot(view);
  const msg: SimSnapshotMessage = { type: 'snapshot', buffer };
  postMessage(msg, [buffer]);
}

function flushEvents(): void {
  if (!world) return;
  const n = world.drainEvents(eventScratch);
  if (n > 0) {
    const msg: SimEventsMessage = { type: 'events', events: eventScratch.slice(0, n), tick: accState.tickCount };
    postMessage(msg);
  }
}

function startTimer(): void {
  if (timerHandle !== undefined) return;
  lastNowMs = performance.now();
  timerHandle = setInterval(() => {
    const nowMs = performance.now();
    const realDtSec = (nowMs - lastNowMs) / 1000;
    lastNowMs = nowMs;
    if (!world || world.paused) return;
    const stepsThisCall = advanceFixedStep(accState, realDtSec, () => {
      (world as World).stepOnce();
      if (shouldEmitSnapshot(accState.tickCount)) emitSnapshotIfBufferAvailable();
    });
    if (stepsThisCall > 0) flushEvents();
  }, 4 /* SIM_WORKER_TIMER_INTERVAL_MS, contracts/sim.ts */);
}

self.onmessage = (e: MessageEvent<MainToSimMessage>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      const deps = buildWorldDependencies(msg.mission);
      world = createWorld(deps);
      snapshotFreeBuffers = [];
      for (let i = 0; i < SNAPSHOT_BUFFER_POOL_SIZE; i++) snapshotFreeBuffers.push(new ArrayBuffer(SNAPSHOT_BYTES));
      world.loadMission(msg.mission);
      accState.accumulatorSec = 0;
      accState.tickCount = 0;
      const ready: SimReadyMessage = { type: 'ready' };
      postMessage(ready);
      startTimer();
      break;
    }
    case 'input': {
      world?.setPlayerInput(msg.entityId, msg.inputs);
      break;
    }
    case 'command': {
      if (!world) break;
      const cmd = msg.command;
      switch (cmd.kind) {
        case 'spawn':
          world.spawnEntity({
            kind: cmd.entityKind,
            team: cmd.team,
            pos: cmd.pos,
            headingRad: cmd.headingRad,
            aircraftDefId: cmd.aircraftDefId,
          });
          break;
        case 'reset':
          world.reset();
          accState.accumulatorSec = 0;
          accState.tickCount = 0;
          break;
        case 'loadMission':
          // NOTE (contract concern): this reuses the World constructed at
          // 'init' time, whose WorldDependencies (sampler/navDb) were built
          // from the FIRST mission's terrain/airports — 10-core-worker.md
          // section 4.9 specifies exactly this (`world.loadMission(cmd.mission)`,
          // no dependency rebuild). A mid-session switch to a mission with
          // different terrain/airports would therefore keep a stale
          // HeightSampler/AirportNavDb. See this module's own return-value
          // writeup for the full note.
          world.loadMission(cmd.mission);
          accState.accumulatorSec = 0;
          accState.tickCount = 0;
          break;
        case 'setDifficulty':
          world.setDifficulty(cmd.entityId, cmd.difficulty);
          break;
        case 'pause':
          world.setPaused(cmd.paused);
          break;
        case 'autopilot':
          world.commandAutopilot(cmd.action);
          break;
      }
      break;
    }
    case 'releaseBuffer': {
      snapshotFreeBuffers.push(msg.buffer);
      break;
    }
  }
};
