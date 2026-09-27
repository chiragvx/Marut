/// <reference types="vite/client" />
/**
 * src/ui/analytics.ts — Vercel Web Analytics: anonymous page views, no cookies. The landing page
 * and the game each call startAnalytics() once. On Vercel the script is served from the site's own
 * /_vercel/insights/ path (Analytics must be enabled for the project in the Vercel dashboard); in
 * development it only logs what it would send.
 */
import { inject } from '@vercel/analytics';

export function startAnalytics(): void {
  inject({ mode: import.meta.env.PROD ? 'production' : 'development' });
}
