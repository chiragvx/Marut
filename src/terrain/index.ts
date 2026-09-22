/**
 * src/terrain/index.ts — barrel re-export (module 04).
 * terrain.worker.ts is deliberately NOT re-exported here: it is a worker
 * bootstrap entry point (compiled under tsconfig.worker.json's WebWorker lib,
 * see 00-architecture.md section 13), not a library module other code imports.
 */
export * from './noise';
export * from './fbm';
export * from './ridge';
export * from './domainWarp';
export * from './terrainHeight';
export * from './heightSampler';
export * from './quadtree';
export * from './chunkGeometryBuilder';
export * from './chunkManager';
