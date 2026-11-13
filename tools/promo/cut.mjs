/**
 * tools/promo/cut.mjs — the promo B-roll's clips (shared by capturePromo.mjs and promoAudio.mjs).
 * shot: a promo shot's index (src/ui/promo.ts), or 'r<i>' for a menu reel shot (src/ui/reel.ts).
 * inCut: false renders the clip on its own but leaves it out of the joined cut.
 */
/** The cut: [name, shot, knots [output s, shot s]] (linear between knots; the clip ends at the last). */
export const CUT = [
  { name: '01-scramble', shot: 0, knots: [[0.0, 0.2], [2.646, 2.4], [4.3, 6.5]] },
  { name: '02-weapons-close', shot: 1, knots: [[0.0, 0], [5.0, 8]] },
  { name: '03-strike-close', shot: 2, knots: [[0.0, 0], [4.5, 7]] },
  { name: '04-afterburner', shot: 11, knots: [[0, 0], [4.5, 5]] },
  { name: '05-off-the-rail', shot: 4, knots: [[0, 0.5], [0.5, 0.95], [2.4, 1.6], [3.0, 2.6]] },
  { name: '06-fox-two', shot: 3, knots: [[0, 0.6], [2.0, 2.6], [3.6, 3.4], [5.0, 6.0]] },
  { name: '07-astra', shot: 5, knots: [[0.0, 0.6], [1.227, 1.2], [2.659, 1.9], [4.5, 4.2]] },
  { name: '08-guns', shot: 6, knots: [[0.0, 0.4], [4.5, 4.8]] },
  { name: '09-guns-night', shot: 7, knots: [[0.0, 0.5], [4.0, 4.7]] },
  { name: '10-bombs-release', shot: 8, knots: [[0.0, 1.0], [1.042, 1.5], [2.5, 1.9], [5.0, 4.6]] },
  { name: '11-bombs-impact', shot: 9, knots: [[0.0, 1.2], [1.853, 3.0], [4.735, 8.4], [7.0, 11.6]] },
  { name: '12-flares', shot: 10, knots: [[0, 0.5], [6, 6.8]] },
  // The menu cinematics (src/ui/reel.ts, ?showcase=r<i>): the second drop and the outro.
  { name: '14-roll', shot: 'r1', knots: [[0.0, 0.3], [0.4, 0.75], [1.2, 1.6], [1.6, 2.4]] }, // aileron roll, into the second drop
  { name: '15-blast', shot: 'r0', knots: [[0, 0.9], [2.08, 2.0], [3.0, 2.9]] }, // low pass at 10 m: slow approach, whips past on the drop (2.08 s in)
  { name: '16-vertical', shot: 'r3', knots: [[0, 0], [2.4, 3.0]] }, // vertical roll on afterburner
  { name: '17-break', shot: 'r2', knots: [[0.0, 0.1], [0.5217, 0.65], [1.3913, 1.35], [2.0, 2.9]] }, // 7 g break, rolling camera
  { name: '18-formation', shot: 'r4', knots: [[0.0, 0.4], [0.7304, 1.0], [1.7739, 1.6], [2.4, 2.8]] }, // pair: the wingman breaks away
  { name: '19-air-to-air', shot: 'r7', knots: [[0, 3.0], [2.0, 5.0]] }, // air-to-air, close
  { name: '20-night-takeoff', shot: 'r5', knots: [[0, 11.0], [2.1, 13.4]] }, // night afterburner take-off
  { name: '21-pull-up', shot: 'r6', knots: [[0.0, 5.6], [0.9128, 6.6], [1.4833, 7.0], [2.9667, 9.6]] }, // low pass and pull-up: ends on the break in the music
  { name: '13-transonic', shot: 12, inCut: false, knots: [[0, 1.85], [0.8, 2.2], [2.4, 2.6], [3.4, 3.4]] },
];

export const sceneT = (knots, u) => {
  for (let i = 1; i < knots.length; i++) {
    const [a0, b0] = knots[i - 1];
    const [a1, b1] = knots[i];
    if (u <= a1) return b0 + ((b1 - b0) * (u - a0)) / (a1 - a0);
  }
  return knots[knots.length - 1][1];
};

/** Shot time to output time (the knots are monotonic). */
export const outT = (knots, t) => {
  for (let i = 1; i < knots.length; i++) {
    const [a0, b0] = knots[i - 1];
    const [a1, b1] = knots[i];
    if (t <= b1) return a0 + ((a1 - a0) * (t - b0)) / (b1 - b0);
  }
  return knots[knots.length - 1][0];
};

/** Loads a promo shot in the dev hold, all UI hidden, the world settled. */
export async function openShot(browser, url0, shot, w, h) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.addInitScript(() => localStorage.setItem('tejas.settings.v1', JSON.stringify({ qualityTierOverride: 'high', version: 1 })));
  await p.goto(`${url0}?showcase=${typeof shot === 'string' ? shot : `p${shot}`},0`);
  await p.waitForSelector('[data-action="free-flight"]', { timeout: 90000 });
  // No UI at all: only the 3D view (and the fade, kept clear).
  await p.addStyleTag({ content: '#ui-root > *{display:none!important} .tj-fade{display:none!important}' });
  await p.waitForTimeout(7000);
  return p;
}
