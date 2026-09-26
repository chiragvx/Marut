/**
 * src/combat/isaDensity.ts — ISA air density by altitude (troposphere, then the isothermal lower
 * stratosphere), for projectile drag and missile lift.
 */
export function isaDensityKgM3(altM: number): number {
  const h = Math.max(-500, altM);
  if (h <= 11000) return 1.225 * Math.pow((288.15 - 0.0065 * h) / 288.15, 4.2559);
  return 0.3639 * Math.exp(-(h - 11000) / 6341.6);
}
