/**
 * src/input/deviceOrientation.ts — DeviceOrientationReader: iOS permission
 * flow, calibration baseline, shaped pitch/roll sample. See
 * docs/spec/09-input.md section 2 and 4.7.
 *
 * `CreateDeviceOrientationReader`'s contract signature is `(target: Window)
 * => DeviceOrientationReader` — it has no way to receive live
 * InputMapData.gyro tuning, so the shaping constants below are fixed at the
 * same values as DEFAULT_INPUT_MAP_DATA.gyro (src/input/inputMap.ts).
 */

import type { CreateDeviceOrientationReader, DeviceOrientationReader, DeviceOrientationSample } from '../contracts/input';
import { applyLinearDeadzone, shapeCurve } from './deadzones';

const DEFAULT_MAX_TILT_DEG = 35;
const DEFAULT_DEADZONE_FRAC = 0.05;
const DEFAULT_CURVE_EXPONENT = 1.0;
const DEFAULT_INVERT_PITCH = false;
const DEFAULT_INVERT_ROLL = false;

/** The non-standard iOS 13+ permission gate, absent from lib.dom.d.ts's DeviceOrientationEvent constructor type. */
interface IosPermissionDeviceOrientationEventCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

function clamp1(x: number): number {
  if (x > 1) return 1;
  if (x < -1) return -1;
  return x;
}

export const createDeviceOrientationReader: CreateDeviceOrientationReader = (target) => {
  let available = false;
  let calibrated = false;
  let rawBeta = 0;
  let rawGamma = 0;
  let betaZero = 0;
  let gammaZero = 0;

  const onOrientation = (event: DeviceOrientationEvent): void => {
    if (event.beta === null || event.gamma === null) return;
    rawBeta = event.beta;
    rawGamma = event.gamma;
    available = true;
  };
  target.addEventListener('deviceorientation', onOrientation);

  const reader: DeviceOrientationReader = {
    get available(): boolean {
      return available;
    },
    get calibrated(): boolean {
      return calibrated;
    },
    async requestPermission(): Promise<boolean> {
      const ctor = (target as unknown as { DeviceOrientationEvent?: IosPermissionDeviceOrientationEventCtor })
        .DeviceOrientationEvent;
      if (ctor && typeof ctor.requestPermission === 'function') {
        try {
          const result = await ctor.requestPermission();
          return result === 'granted';
        } catch {
          return false;
        }
      }
      // Not required on this platform.
      return true;
    },
    calibrate(): void {
      betaZero = rawBeta;
      gammaZero = rawGamma;
      calibrated = true;
    },
    sample(out: DeviceOrientationSample): DeviceOrientationSample {
      if (!calibrated) {
        out.pitchRad = 0;
        out.rollRad = 0;
        return out;
      }
      let dPitch = clamp1((rawBeta - betaZero) / DEFAULT_MAX_TILT_DEG);
      let dRoll = clamp1((rawGamma - gammaZero) / DEFAULT_MAX_TILT_DEG);
      dPitch = applyLinearDeadzone(dPitch, DEFAULT_DEADZONE_FRAC) * (DEFAULT_INVERT_PITCH ? -1 : 1);
      dRoll = applyLinearDeadzone(dRoll, DEFAULT_DEADZONE_FRAC) * (DEFAULT_INVERT_ROLL ? -1 : 1);
      out.pitchRad = shapeCurve(dPitch, DEFAULT_CURVE_EXPONENT);
      out.rollRad = shapeCurve(dRoll, DEFAULT_CURVE_EXPONENT);
      return out;
    },
    dispose(): void {
      target.removeEventListener('deviceorientation', onOrientation);
    },
  };
  return reader;
};
