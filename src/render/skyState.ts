/**
 * src/render/skyState.ts — time of day and weather as plain numbers: where the sun and moon are,
 * what colour the sky, haze and light are, and what the weather is doing (a fixed preset, or
 * random weather that drifts from one preset to the next). Pure (no three.js) so it is unit-tested;
 * scene.ts applies the result to the shared uniforms.
 *
 * World axes: x east, y up, z south. Times are local solar time in hours (12 = noon).
 */
import type { SceneEnvironment } from '../contracts/render';
import type { WeatherMode } from '../contracts/core';

export type Rgb = [number, number, number];
export interface Dir3 {
  x: number;
  y: number;
  z: number;
}

/** Solar declination used all year (deg): mid-February, the dry season both theatres are drawn in. */
const SUN_DECLINATION_DEG = -12;

const D2R = Math.PI / 180;

/** Unit vector towards a body at hour angle (hours - 12) * 15 deg, from latitude latDeg. */
export function celestialDir(hours: number, latDeg: number, decDeg: number, out: Dir3): Dir3 {
  const h = (hours - 12) * 15 * D2R;
  const lat = latDeg * D2R;
  const dec = decDeg * D2R;
  const east = -Math.cos(dec) * Math.sin(h);
  const north = Math.cos(lat) * Math.sin(dec) - Math.sin(lat) * Math.cos(dec) * Math.cos(h);
  const up = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h);
  out.x = east;
  out.y = up;
  out.z = -north;
  return out;
}

/**
 * Local solar time minus Indian Standard Time, hours: both theatres sit ~8 degrees of longitude
 * west of the IST meridian (-33 min) and the equation of time in February is -14 min. So the
 * clock reads sunset in Goa at ~18:30, as it does.
 */
export const SOLAR_MINUS_CLOCK_H = -0.78;

/** Sun direction at clock time `hours` (IST). */
export function sunDirAt(hours: number, latDeg: number, out: Dir3): Dir3 {
  return celestialDir(hours + SOLAR_MINUS_CLOCK_H, latDeg, SUN_DECLINATION_DEG, out);
}

/** A full moon: opposite the sun, rising at sunset and high around midnight (so nights are moonlit). */
export function moonDirAt(hours: number, latDeg: number, out: Dir3): Dir3 {
  return celestialDir(hours + SOLAR_MINUS_CLOCK_H + 12, latDeg, -SUN_DECLINATION_DEG, out);
}

export function latitudeFor(style: SceneEnvironment['surfaceStyle']): number {
  return style === 'coastal' ? 15.4 : style === 'farmland' ? 31.4 : 25;
}

// ---------------------------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------------------------

export interface WeatherState {
  /** Meteorological visibility at ground level, km. */
  visKm: number;
  /** Haze/fog scale height, m (a low one is a fog layer you can climb out of). */
  hazeScaleM: number;
  /** 0 = the theatre's tinted haze and blue sky, 1 = flat grey. */
  grey: number;
  /** Fraction of cumulus cells with a cloud. */
  cumulus: number;
  /** 0 = white fair-weather cumulus, 1 = dark rain clouds. */
  cloudDark: number;
  /** Overcast stratus deck cover, 0..1. */
  deck: number;
  /** Rain intensity, 0..1. */
  rain: number;
}

export type WeatherPreset = Exclude<WeatherMode, 'dynamic'>;

interface TheatreClimate {
  visKm: number;
  scaleM: number;
  cumulus: number;
  /** Chance of each preset in dynamic weather. */
  weights: Partial<Record<WeatherPreset, number>>;
}

const CLIMATE: Readonly<Record<SceneEnvironment['surfaceStyle'], TheatreClimate>> = {
  // Goa: humid coast; sea haze, cumulus, monsoon-like overcast and rain showers, rarely fog.
  coastal: { visKm: 60, scaleM: 1000, cumulus: 0.09, weights: { clear: 0.35, hazy: 0.25, overcast: 0.2, rain: 0.2 } },
  // Punjab in winter: haze and smog, famous dense fog, the odd grey rainy day.
  farmland: { visKm: 70, scaleM: 1100, cumulus: 0.22, weights: { clear: 0.35, hazy: 0.25, fog: 0.15, overcast: 0.15, rain: 0.1 } },
  default: { visKm: 45, scaleM: 1200, cumulus: 0.15, weights: { clear: 0.4, hazy: 0.25, overcast: 0.2, rain: 0.15 } },
};

export function weatherPreset(preset: WeatherPreset, style: SceneEnvironment['surfaceStyle']): WeatherState {
  const c = CLIMATE[style];
  switch (preset) {
    case 'off':
      return { visKm: c.visKm, hazeScaleM: c.scaleM, grey: 0, cumulus: 0, cloudDark: 0, deck: 0, rain: 0 };
    case 'clear':
      return { visKm: c.visKm, hazeScaleM: c.scaleM, grey: 0, cumulus: c.cumulus, cloudDark: 0, deck: 0, rain: 0 };
    case 'hazy':
      return { visKm: 12, hazeScaleM: 1600, grey: 0.3, cumulus: c.cumulus * 0.5, cloudDark: 0.1, deck: 0, rain: 0 };
    case 'fog':
      return { visKm: 1.0, hazeScaleM: 160, grey: 0.75, cumulus: 0, cloudDark: 0, deck: 0, rain: 0 };
    case 'overcast':
      return { visKm: 25, hazeScaleM: 1300, grey: 0.7, cumulus: 0.12, cloudDark: 0.45, deck: 0.93, rain: 0 };
    case 'rain':
      return { visKm: 5, hazeScaleM: 1600, grey: 0.9, cumulus: 0.2, cloudDark: 0.85, deck: 1, rain: 1 };
  }
}

/** Blends weather a -> b by t (visibility in log space, so fog clears gradually). */
export function lerpWeather(a: WeatherState, b: WeatherState, t: number, out: WeatherState): WeatherState {
  const l = (x: number, y: number): number => x + (y - x) * t;
  out.visKm = Math.exp(l(Math.log(a.visKm), Math.log(b.visKm)));
  out.hazeScaleM = Math.exp(l(Math.log(a.hazeScaleM), Math.log(b.hazeScaleM)));
  out.grey = l(a.grey, b.grey);
  out.cumulus = l(a.cumulus, b.cumulus);
  out.cloudDark = l(a.cloudDark, b.cloudDark);
  out.deck = l(a.deck, b.deck);
  out.rain = l(a.rain, b.rain);
  return out;
}

export interface DynamicWeather {
  /** Advances by dtSec and returns the current (blended) weather. */
  update(dtSec: number): WeatherState;
  readonly current: WeatherState;
  /** The preset being held or blended towards. */
  readonly preset: WeatherPreset;
}

/** Random weather: holds a preset for 4-8 minutes, then blends to another over two minutes. */
export function createDynamicWeather(style: SceneEnvironment['surfaceStyle'], seed: number): DynamicWeather {
  let s = seed >>> 0 || 1;
  const rand = (): number => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const weights = Object.entries(CLIMATE[style].weights) as [WeatherPreset, number][];
  const pick = (not?: WeatherPreset): WeatherPreset => {
    const opts = weights.filter(([p]) => p !== not);
    const total = opts.reduce((a, [, w]) => a + w, 0);
    let r = rand() * total;
    for (const [p, w] of opts) {
      r -= w;
      if (r <= 0) return p;
    }
    return opts[opts.length - 1]![0];
  };
  const HOLD_MIN_S = 240;
  const HOLD_MAX_S = 480;
  const BLEND_S = 120;
  let from = pick();
  let to = from;
  let fromW = weatherPreset(from, style);
  let toW = fromW;
  let hold = HOLD_MIN_S + rand() * (HOLD_MAX_S - HOLD_MIN_S);
  let blend = 1;
  const current = { ...fromW };
  return {
    current,
    get preset() {
      return to;
    },
    update(dt) {
      if (blend < 1) {
        blend = Math.min(1, blend + dt / BLEND_S);
        const t = blend * blend * (3 - 2 * blend);
        lerpWeather(fromW, toW, t, current);
        if (blend >= 1) {
          from = to;
          fromW = toW;
          hold = HOLD_MIN_S + rand() * (HOLD_MAX_S - HOLD_MIN_S);
        }
      } else {
        hold -= dt;
        if (hold <= 0) {
          to = pick(from);
          toW = weatherPreset(to, style);
          blend = 0;
        }
      }
      return current;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Light and sky colours
// ---------------------------------------------------------------------------------------------

export interface SkyLight {
  /** The light that lights and shadows the world: the sun, or the moon at night. */
  keyDir: Dir3;
  /** Where the haze glows: the sun until deep twilight (sunset colours after it sets), then the moon. */
  glowDir: Dir3;
  /** Direct light colour x intensity (midday sun ~ (0.62, 0.60, 0.56)). */
  keyCol: Rgb;
  /** Hemisphere ambient from above and from the ground. */
  ambSky: Rgb;
  ambGround: Rgb;
  zenith: Rgb;
  /** Haze colour at the horizon (away from the sun). */
  horizon: Rgb;
  /** Forward-scattered light around the sun (or moon) in the haze. */
  glow: Rgb;
  /** Sun and moon disc colours (black = hidden). */
  sunDisc: Rgb;
  moonDisc: Rgb;
  /** Star brightness, 0..1. */
  stars: number;
  /** Lights on (towns, runways): 0 by day, 1 at night. */
  lights: number;
  /** Lens glare from the sun, 0..1. */
  glare: number;
}

export function createSkyLight(): SkyLight {
  const z = (): Rgb => [0, 0, 0];
  return { keyDir: { x: 0, y: 1, z: 0 }, glowDir: { x: 0, y: 1, z: 0 }, keyCol: z(), ambSky: z(), ambGround: z(), zenith: z(), horizon: z(), glow: z(), sunDisc: z(), moonDisc: z(), stars: 0, lights: 0, glare: 0 };
}

const ss = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: Readonly<Rgb>, b: Readonly<Rgb>, t: number, out: Rgb): Rgb => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};
const scale3 = (a: Rgb, k: number): Rgb => {
  a[0] *= k;
  a[1] *= k;
  a[2] *= k;
  return a;
};
/** Towards a neutral grey of the same brightness, by t. */
const greyed = (a: Rgb, t: number): Rgb => {
  const l = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  return mix3(a, [l * 0.98, l, l * 1.03], t, a);
};

const DAY_SUN: Rgb = [1.0, 0.97, 0.9];
const LOW_SUN: Rgb = [1.0, 0.55, 0.28];
const MOON: Rgb = [0.55, 0.66, 0.9];
const DAY_AMB_SKY: Rgb = [0.44, 0.47, 0.52];
const DAY_AMB_GROUND: Rgb = [0.3, 0.27, 0.22];
const TWI_AMB_SKY: Rgb = [0.15, 0.17, 0.26];
const TWI_AMB_GROUND: Rgb = [0.07, 0.065, 0.075];
const NIGHT_AMB_SKY: Rgb = [0.045, 0.058, 0.095];
const NIGHT_AMB_GROUND: Rgb = [0.016, 0.018, 0.024];
const TWI_ZENITH: Rgb = [0.11, 0.17, 0.34];
const NIGHT_ZENITH: Rgb = [0.006, 0.01, 0.026];
const TWI_HORIZON: Rgb = [0.42, 0.4, 0.5];
const NIGHT_HORIZON: Rgb = [0.024, 0.03, 0.05];
const DAY_GLOW: Rgb = [1.0, 0.94, 0.82];
const SUNSET_GLOW: Rgb = [1.0, 0.5, 0.22];
const MOON_GLOW: Rgb = [0.07, 0.08, 0.11];

/**
 * Light and sky for the sun/moon positions and the weather. baseZenith/baseHorizon are the
 * theatre's clear midday sky and haze colours (skyFog.ts).
 */
export function computeSkyLight(sun: Readonly<Dir3>, moon: Readonly<Dir3>, baseZenith: Readonly<Rgb>, baseHorizon: Readonly<Rgb>, w: Readonly<WeatherState>, out: SkyLight): SkyLight {
  const e = Math.asin(Math.max(-1, Math.min(1, sun.y))) / D2R;
  const me = Math.asin(Math.max(-1, Math.min(1, moon.y))) / D2R;
  const tmp: Rgb = [0, 0, 0];
  const fog = 1 - ss(1, 8, w.visKm);

  // Direct light: the sun (reddening and fading near the horizon) or, once it is well down, the moon.
  const sunI = ss(-1.5, 6, e);
  const lowSun = 1 - ss(3, 25, e);
  const night = 1 - ss(-10, -3, e);
  const moonI = night * ss(-1, 10, me);
  const useSun = e > -4.5;
  const dir = useSun ? sun : moon;
  out.keyDir.x = dir.x;
  out.keyDir.y = dir.y;
  out.keyDir.z = dir.z;
  if (useSun) scale3(mix3(DAY_SUN, LOW_SUN, lowSun, out.keyCol), 0.62 * sunI);
  else scale3(mix3(MOON, MOON, 0, out.keyCol), 0.26 * moonI); // (mix3 with t = 0 copies)
  // Overcast and fog take most of the direct light.
  scale3(out.keyCol, (1 - 0.8 * w.deck) * (1 - 0.55 * fog));

  // Ambient: night -> twilight -> day, flatter and greyer under cloud.
  const toTwi = ss(-12, -4, e);
  const toDay = ss(-4, 12, e);
  mix3(mix3(NIGHT_AMB_SKY, TWI_AMB_SKY, toTwi, tmp), DAY_AMB_SKY, toDay, out.ambSky);
  mix3(mix3(NIGHT_AMB_GROUND, TWI_AMB_GROUND, toTwi, tmp), DAY_AMB_GROUND, toDay, out.ambGround);
  greyed(out.ambSky, w.deck * 0.6);
  scale3(out.ambSky, 1 - 0.25 * w.deck - 0.05 * w.rain);
  scale3(out.ambGround, 1 - 0.3 * w.deck);
  // Moonlight adds a little to the night ambient.
  scale3(out.ambSky, 1 + 0.5 * moonI * (1 - w.deck));

  // Sky dome and haze.
  mix3(mix3(NIGHT_ZENITH, TWI_ZENITH, ss(-14, -4, e), tmp), baseZenith, ss(-4, 10, e), out.zenith);
  mix3(mix3(NIGHT_HORIZON, TWI_HORIZON, ss(-12, -3, e), tmp), baseHorizon, ss(-3, 10, e), out.horizon);
  // Overcast: the dome becomes the deck's grey underside; fog: a whiter haze.
  mix3(out.zenith, out.horizon, w.deck * 0.85, out.zenith);
  greyed(out.zenith, Math.max(w.grey, w.deck));
  greyed(out.horizon, w.grey);
  const dim = 1 - 0.3 * w.deck - 0.12 * w.rain;
  scale3(out.zenith, dim);
  scale3(out.horizon, dim * (1 + 0.08 * fog));

  // Sunset colours linger around the set sun through twilight; after that the moon's faint halo.
  const glowSun = e > -11;
  const g = glowSun ? sun : moon;
  out.glowDir.x = g.x;
  out.glowDir.y = g.y;
  out.glowDir.z = g.z;
  if (glowSun) scale3(mix3(DAY_GLOW, SUNSET_GLOW, lowSun, out.glow), ss(-11, 0, e) * (0.45 + 0.55 * ss(-4, 6, e)) * (1 - 0.85 * w.deck));
  else scale3(mix3(MOON_GLOW, MOON_GLOW, 0, out.glow), moonI * (1 - w.deck));

  const clearSky = (1 - w.deck) * (1 - fog);
  scale3(mix3(DAY_GLOW, LOW_SUN, lowSun, out.sunDisc), Math.min(1, sunI * 4) * clearSky);
  const moonDisc: Rgb = [0.85, 0.87, 0.92];
  scale3(mix3(moonDisc, moonDisc, 0, out.moonDisc), ss(2, 8, -e) * ss(-2, 2, me) * clearSky);
  out.stars = night * clearSky * ss(3, 20, w.visKm);
  out.lights = 1 - ss(-3, 6, e);
  out.glare = sunI * clearSky;
  return out;
}
