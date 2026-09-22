/**
 * src/ui/qualityTierDetect.ts — implements ClassifyGpuRenderer,
 * ReadWebglRendererStrings, ComputeQualityTier, DetectQualityTier
 * (docs/spec/11-ui.md section 4.2, token tables section 5.1/5.2).
 */
import { QualityTier } from '../contracts/core';
import type {
  ClassifyGpuRenderer,
  ComputeQualityTier,
  DetectQualityTier,
  GpuInfo,
  ReadWebglRendererStrings,
} from '../contracts/ui';
import {
  BENCHMARK_DURATION_MS,
  BENCHMARK_TRIANGLE_COUNT,
  BENCHMARK_WARMUP_MS,
  DEVICE_PIXEL_RATIO_CAP,
  GpuStrengthHint,
  QUALITY_BENCHMARK_FPS_THRESHOLDS,
} from '../contracts/ui';
import { runRenderBenchmark } from './benchmark';

const BENCHMARK_CANVAS_CSS_WIDTH_PX = 480;
const BENCHMARK_CANVAS_CSS_HEIGHT_PX = 270;

// Section 5.1. Lower-case substrings of the WebGL renderer string.
const STRONG_GPU_TOKENS: readonly string[] = [
  'rtx',
  'gtx 16',
  'gtx 20',
  'gtx 30',
  'gtx 40',
  'gtx 50',
  'radeon rx',
  'radeon pro w',
  'apple m1',
  'apple m2',
  'apple m3',
  'apple m4',
  'adreno 7',
  'adreno 8',
  'mali-g7',
  'mali-g8',
  'mali-g9',
  'xclipse',
];

// Section 5.2.
const WEAK_GPU_TOKENS: readonly string[] = [
  'adreno 2',
  'adreno 3',
  'adreno 4',
  'adreno 5',
  'mali-4',
  'mali-t',
  'mali-g3',
  'mali-g5',
  'powervr',
  'intel(r) hd graphics',
  'intel(r) uhd graphics 6',
  'swiftshader',
  'llvmpipe',
  'software',
  'microsoft basic render',
];

/**
 * Real-world ANGLE renderer strings often insert a "(TM)"/"™" trademark
 * marker between a GPU family name and its model number (e.g.
 * "Adreno (TM) 530"), which would otherwise defeat a plain substring match
 * against a token like "adreno 5". This normalisation strips that specific
 * noise (and collapses the whitespace it leaves behind) before matching,
 * while leaving other trademark markers like Intel's "(R)" untouched since
 * WEAK_GPU_TOKENS's own 'intel(r) hd graphics' token is written to match
 * those literally. Case-insensitive substring match is otherwise unchanged.
 */
function normalizeRendererString(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(tm\)|™/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const classifyGpuRenderer: ClassifyGpuRenderer = (rendererString, vendorString) => {
  const lower = normalizeRendererString(rendererString);
  let strengthHint: GpuInfo['strengthHint'] = GpuStrengthHint.Unknown;
  if (WEAK_GPU_TOKENS.some((t) => lower.includes(t))) {
    strengthHint = GpuStrengthHint.Weak;
  } else if (STRONG_GPU_TOKENS.some((t) => lower.includes(t))) {
    strengthHint = GpuStrengthHint.Strong;
  }
  return { vendor: vendorString, renderer: rendererString, strengthHint };
};

export const readWebglRendererStrings: ReadWebglRendererStrings = (canvas) => {
  try {
    const gl = (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (gl === null) return { renderer: 'unknown', vendor: 'unknown' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext === null) return { renderer: 'unknown', vendor: 'unknown' };
    const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as unknown;
    const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as unknown;
    return {
      renderer: typeof renderer === 'string' && renderer.length > 0 ? renderer : 'unknown',
      vendor: typeof vendor === 'string' && vendor.length > 0 ? vendor : 'unknown',
    };
  } catch {
    return { renderer: 'unknown', vendor: 'unknown' };
  }
};

export const computeQualityTier: ComputeQualityTier = (gpu, benchmark, devicePixelRatioCapped) => {
  const reasons: string[] = [];

  let gpuScore = 0;
  if (gpu.strengthHint === GpuStrengthHint.Strong) gpuScore = 2;
  else if (gpu.strengthHint === GpuStrengthHint.Weak) gpuScore = -2;
  reasons.push(`gpu: ${gpu.renderer} -> ${gpu.strengthHint} (${gpuScore >= 0 ? '+' : ''}${gpuScore})`);

  let benchmarkScore = 0;
  let bucket = 'low';
  if (benchmark.fps >= QUALITY_BENCHMARK_FPS_THRESHOLDS.ULTRA) {
    benchmarkScore = 3;
    bucket = 'ultra';
  } else if (benchmark.fps >= QUALITY_BENCHMARK_FPS_THRESHOLDS.HIGH) {
    benchmarkScore = 2;
    bucket = 'high';
  } else if (benchmark.fps >= QUALITY_BENCHMARK_FPS_THRESHOLDS.MEDIUM) {
    benchmarkScore = 1;
    bucket = 'medium';
  }
  reasons.push(`benchmark: ${benchmark.fps.toFixed(1)}fps -> ${bucket} (${benchmarkScore >= 0 ? '+' : ''}${benchmarkScore})`);

  // ComputeQualityTier only receives the already-capped DPR (the caller,
  // DetectQualityTier, is the only place that ever sees the raw value before
  // capping it) — both slots of this message use the same capped number.
  reasons.push(`devicePixelRatio: ${devicePixelRatioCapped} capped to ${devicePixelRatioCapped}`);

  const combined = gpuScore + benchmarkScore;
  let tier: QualityTier;
  if (combined <= 0) tier = QualityTier.Low;
  else if (combined <= 2) tier = QualityTier.Medium;
  else if (combined <= 4) tier = QualityTier.High;
  else tier = QualityTier.Ultra;
  reasons.push(`combined score ${combined} -> ${tier}`);

  return { tier, reasons, gpu, benchmark, devicePixelRatioCapped };
};

export const detectQualityTier: DetectQualityTier = async (canvas) => {
  const dpr = Math.min(window.devicePixelRatio || 1, DEVICE_PIXEL_RATIO_CAP);
  canvas.width = Math.round(BENCHMARK_CANVAS_CSS_WIDTH_PX * dpr);
  canvas.height = Math.round(BENCHMARK_CANVAS_CSS_HEIGHT_PX * dpr);
  const { renderer, vendor } = readWebglRendererStrings(canvas);
  const gpu = classifyGpuRenderer(renderer, vendor);
  const benchmark = await runRenderBenchmark(canvas, BENCHMARK_DURATION_MS, BENCHMARK_WARMUP_MS, BENCHMARK_TRIANGLE_COUNT);
  return computeQualityTier(gpu, benchmark, dpr);
};
