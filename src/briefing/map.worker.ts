/**
 * src/briefing/map.worker.ts — samples the table map's height grid off the main thread (about
 * 50,000 terrain samples: a few tenths of a second on a slow PC, which would otherwise stall the
 * intro and the mission loading under it). Replies once with the grid (mapData.ts MapGrid).
 */
import { buildMapGrid } from './mapData';
import { heightAt, waterLevelAt } from '../terrain/himalaya/height';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<{ n?: number }>) => {
  const g = buildMapGrid(heightAt, waterLevelAt, e.data.n);
  ctx.postMessage(g, [g.xs.buffer, g.zs.buffer, g.h.buffer, g.rgb.buffer]);
};
