/**
 * src/ui/index.ts — barrel re-export for the whole UI module (module 11).
 */

export { createMainMenu } from './mainMenu';
export { createFreeFlightSetup, DEFAULT_FREE_FLIGHT, type FreeFlightSetup } from './freeFlight';
export { createMissionList, createBriefing, formatDuration, type MissionProgress } from './missions';
export { createLoadoutEditor, type LoadoutSelection } from './loadoutEditor';
export { createControlsScreen, type ControlGroup } from './controls';
export { createDeviceNotice, isTouchFirstDevice } from './deviceNotice';
export { GAME_NAME, GAME_VERSION, feedbackUrl } from './links';
export { keyLabel } from './kit';
export { createSettingsScreen } from './settings';
export { createPauseMenu } from './pauseMenu';
export { createDebriefScreen } from './debrief';
export { createLoadingScreen } from './loadingScreen';
export { mountOrientationPrompt } from './orientationPrompt';

export { classifyGpuRenderer, readWebglRendererStrings, computeQualityTier, detectQualityTier } from './qualityTierDetect';
export { runRenderBenchmark } from './benchmark';


export { registerServiceWorker } from './pwa';
