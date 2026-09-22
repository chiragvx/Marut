import { describe, it, expect } from 'vitest';
import { classifyGpuRenderer, computeQualityTier } from '../../src/ui/qualityTierDetect';

describe('classifyGpuRenderer', () => {
  it('classifies an RTX renderer string as strong', () => {
    const result = classifyGpuRenderer(
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'Google Inc. (NVIDIA)'
    );
    expect(result.strengthHint).toBe('strong');
  });

  it('classifies an Adreno 530 renderer string as weak', () => {
    const result = classifyGpuRenderer('ANGLE (Qualcomm, Adreno (TM) 530, OpenGL ES 3.2)', 'Qualcomm');
    expect(result.strengthHint).toBe('weak');
  });

  it('classifies SwiftShader as weak', () => {
    const result = classifyGpuRenderer('SwiftShader', 'Google Inc.');
    expect(result.strengthHint).toBe('weak');
  });

  it('classifies Apple M2 Pro as strong', () => {
    const result = classifyGpuRenderer('Apple GPU (Apple M2 Pro)', 'Apple');
    expect(result.strengthHint).toBe('strong');
  });

  it('classifies an unrecognised GPU as unknown', () => {
    const result = classifyGpuRenderer('Some Unrecognised GPU XYZ', 'Vendor');
    expect(result.strengthHint).toBe('unknown');
  });
});

describe('computeQualityTier', () => {
  it('strong GPU + 60fps -> ultra', () => {
    const report = computeQualityTier({ vendor: '', renderer: '', strengthHint: 'strong' }, { avgFrameMs: 16.7, fps: 60, samples: 90 }, 2);
    expect(report.tier).toBe('ultra');
  });

  it('unknown GPU + 45fps -> medium', () => {
    const report = computeQualityTier({ vendor: '', renderer: '', strengthHint: 'unknown' }, { avgFrameMs: 22.2, fps: 45, samples: 90 }, 1);
    expect(report.tier).toBe('medium');
  });

  it('weak GPU + 20fps -> low', () => {
    const report = computeQualityTier({ vendor: '', renderer: '', strengthHint: 'weak' }, { avgFrameMs: 50, fps: 20, samples: 90 }, 1);
    expect(report.tier).toBe('low');
  });

  it('unknown GPU + 56fps -> high', () => {
    const report = computeQualityTier({ vendor: '', renderer: '', strengthHint: 'unknown' }, { avgFrameMs: 17.9, fps: 56, samples: 90 }, 1);
    expect(report.tier).toBe('high');
  });
});
