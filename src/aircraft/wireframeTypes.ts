/**
 * src/aircraft/wireframeTypes.ts — thin local re-export of `WireframeModel`/
 * `WireframeGroup` from `contracts/aircraft.ts`, so `tejasWireframe.json` has
 * a typed import site (`import wireframeJson from './tejasWireframe.json'`
 * under `resolveJsonModule`). No new shape is declared here — this file
 * carries no logic, per 03-tejas-data.md section 2.
 */
export type { WireframeModel, WireframeGroup } from '../contracts/aircraft';
