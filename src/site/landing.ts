/// <reference types="vite/client" />
/**
 * src/site/landing.ts — the landing page's only script (it never loads the game): fills in the
 * name, version and feedback links from src/ui/links.ts, offers "Install app" where the browser
 * allows it, on phones and tablets swaps Play for a "best on a desktop" note, solidifies the nav
 * once the hero has scrolled away, reveals the sections as they come into view and plays the hero
 * reel (tools/site/captureReel.mjs) over the hero's still.
 */
import '../ui/ui.css';
import './site.css';
import { FEEDBACK_URL, GAME_NAME, GAME_VERSION, feedbackUrl } from '../ui/links';
import { externalLink } from '../ui/kit';
import { isTouchFirstDevice } from '../ui/deviceNotice';
import { startAnalytics } from '../ui/analytics';
import reel900Webm from './media/reel-900.webm';
import reel900Mp4 from './media/reel-900.mp4';
import reel540Webm from './media/reel-540.webm';
import reel540Mp4 from './media/reel-540.mp4';

startAnalytics();

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
    ? Object.assign(document.createElement('a'), { className: 'site-btn site-btn--ghost site-btn--big', href: fb, target: '_blank', rel: 'noopener', textContent: 'Give feedback ↗' })
    : Object.assign(document.createElement('span'), { className: 'site-btn site-btn--ghost site-btn--big', textContent: 'Feedback soon', ariaDisabled: 'true' });
  el.replaceWith(link);
}

// Phones and tablets: the game is keyboard-first.
if (isTouchFirstDevice()) {
  for (const el of q('actions')) el.classList.add('site-hidden');
  for (const el of q('desktop-note')) el.classList.remove('site-hidden');
}

// The nav: clear over the hero, solid once it has scrolled away.
const nav = q('nav')[0];
if (nav) {
  const onScroll = (): void => {
    nav.classList.toggle('site-nav--solid', window.scrollY > window.innerHeight * 0.6);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// Sections rise into view as they are scrolled to (visible from the start without the observer).
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.body.classList.add('site-js');
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('site-in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -12% 0px' }
  );
  for (const el of Array.from(document.querySelectorAll('.site-reveal'))) io.observe(el);
}

// The hero reel: a muted loop over the still (which stays for reduced motion and data saver), the
// smaller cut on small screens, fading in once it plays and paused while the hero is out of view.
const heroMedia = document.querySelector<HTMLElement>('.site-hero-media');
const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
if (heroMedia && !saveData && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const big = Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1) > 1300;
  const video = Object.assign(document.createElement('video'), { muted: true, loop: true, autoplay: true, playsInline: true, preload: 'auto' });
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  for (const [src, type] of big ? [[reel900Webm, 'video/webm; codecs=vp9'], [reel900Mp4, 'video/mp4']] : [[reel540Webm, 'video/webm; codecs=vp9'], [reel540Mp4, 'video/mp4']]) {
    video.append(Object.assign(document.createElement('source'), { src, type }));
  }
  video.addEventListener('playing', () => video.classList.add('site-on'), { once: true });
  heroMedia.append(video);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) void video.play().catch(() => undefined);
      else video.pause();
    }).observe(heroMedia);
  }
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
