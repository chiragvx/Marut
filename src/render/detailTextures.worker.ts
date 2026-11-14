/**
 * src/render/detailTextures.worker.ts — builds the ground detail textures' texels
 * (detailTextureData.ts) off the main thread and posts them back (transferred), once; the page
 * then ends the worker (detailTextures.ts). Compiled under tsconfig.worker.json (lib: WebWorker).
 */
import { buildDetailData } from './detailTextureData';

const data = buildDetailData();
self.postMessage(data, [data.buffer]);
