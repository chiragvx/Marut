/**
 * src/ui/links.ts — the game's name, version and outside links, in one place for the game and the
 * landing page.
 *
 * FEEDBACK_URL is the third-party feedback form: empty until the form exists, and every feedback
 * link then reads "coming soon".
 */

export const GAME_NAME = 'Marut';
export const GAME_VERSION = '0.1.0-wireframe';
export const FEEDBACK_URL = '';

export interface FeedbackContext {
  /** Where the player was: 'menu', 'pause', 'debrief', 'landing'. */
  screen: string;
  missionId?: string;
  quality?: string;
}

/**
 * The feedback form's address with context for pre-filled fields (version, screen, mission, graphics
 * quality, browser), or undefined while there is no form. No personal data or identifiers.
 */
export function feedbackUrl(ctx: FeedbackContext): string | undefined {
  if (!FEEDBACK_URL) return undefined;
  const u = new URL(FEEDBACK_URL);
  u.searchParams.set('version', GAME_VERSION);
  u.searchParams.set('screen', ctx.screen);
  if (ctx.missionId) u.searchParams.set('mission', ctx.missionId);
  if (ctx.quality) u.searchParams.set('quality', ctx.quality);
  if (typeof navigator !== 'undefined') u.searchParams.set('browser', navigator.userAgent.slice(0, 120));
  return u.toString();
}
