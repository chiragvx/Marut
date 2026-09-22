import { describe, it, expect } from 'vitest';
import { runRenderBenchmark } from '../../src/ui/benchmark';

describe('runRenderBenchmark fallback', () => {
  it('resolves {avgFrameMs:0, fps:0, samples:0} when no WebGL context is available, never throws or rejects', async () => {
    const canvas = {
      getContext: () => null,
      width: 480,
      height: 270,
    } as unknown as HTMLCanvasElement;

    const result = await runRenderBenchmark(canvas, 100, 10, 1000);
    expect(result).toEqual({ avgFrameMs: 0, fps: 0, samples: 0 });
  });
});
