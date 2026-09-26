/**
 * src/ui/index.ts — barrel re-export for the whole UI module (module 11).
 */

export { createMainMenu } from './mainMenu';
export { createMissionSelect } from './missionSelect';
export { createSettingsScreen } from './settings';
export { createPauseMenu } from './pauseMenu';
export { createDebriefScreen } from './debrief';
export { createLoadingScreen } from './loadingScreen';
export { mountOrientationPrompt } from './orientationPrompt';

export { classifyGpuRenderer, readWebglRendererStrings, computeQualityTier, detectQualityTier } from './qualityTierDetect';
export { runRenderBenchmark } from './benchmark';


export { registerServiceWorker } from './pwa';
