/// <reference types="vite/client" />
/**
 * src/site/landing.ts — the landing page's only script (it never loads the game): fills in the
 * name, version and feedback links from src/ui/links.ts, offers "Install app" where the browser
 * allows it, and on phones and tablets swaps Play for a "best on a desktop" note.
 */
import '../ui/ui.css';
import './site.css';
import { FEEDBACK_URL, GAME_NAME, GAME_VERSION, feedbackUrl } from '../ui/links';
import { externalLink } from '../ui/kit';
import { isTouchFirstDevice } from '../ui/deviceNotice';

const q = <T extends HTMLElement>(key: string): T[] => Array.from(document.querySelectorAll<T>(`[data-site="${key}"]`));

for (const el of q('name')) el.textContent = GAME_NAME;
document.title = `${GAME_NAME}: combat flight over India, in your browser`;
for (const el of q('version')) el.textContent = `Early access · v${GAME_VERSION}`;
for (const el of q('version-footer')) el.textContent = `v${GAME_VERSION}`;

const fb = FEEDBACK_URL ? feedbackUrl({ screen: 'landing' }) : undefined;
for (const el of q('feedback-nav')) el.replaceWith(externalLink('Feedback', fb, 'Feedback (soon)'));
for (const el of q('feedback-footer')) el.replaceWith(externalLink('Feedback', fb, 'Feedback (coming soon)'));
for (const el of q('feedback-band')) {
  const link = fb
    ? Object.assign(document.createElement('a'), { className: 'tj-btn tj-btn--big', href: fb, target: '_blank', rel: 'noopener', textContent: 'Give feedback ↗' })
    : Object.assign(document.createElement('span'), { className: 'tj-btn tj-btn--big', textContent: 'Feedback form coming soon', ariaDisabled: 'true' });
  el.replaceWith(link);
}

// Phones and tablets: the game is keyboard-first.
if (isTouchFirstDevice()) {
  for (const el of q('actions')) el.classList.add('tj-hidden');
  for (const el of q('desktop-note')) el.classList.remove('tj-hidden');
}

// Install as an app, where the browser offers it.
interface InstallPrompt extends Event {
  prompt(): Promise<void>;
}
let deferred: InstallPrompt | undefined;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e as InstallPrompt;
  for (const b of q<HTMLButtonElement>('install')) b.hidden = false;
});
for (const b of q<HTMLButtonElement>('install')) {
  b.addEventListener('click', () => {
    void deferred?.prompt();
    deferred = undefined;
    b.hidden = true;
  });
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('./service-worker.js').catch(() => undefined);
