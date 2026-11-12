/**
 * src/ui/training.ts — Flight School: the lesson list and a lesson's briefing.
 *
 * List: the four lessons as numbered tiles (title, one line, the skills it teaches, how long it
 * takes, done with the best time), the next one to fly marked. Briefing: what happens, the skills,
 * the basic keys, then Start. The lessons themselves are src/script/missions/training.ts.
 */
import type { ScreenHandle } from '../contracts/ui';
import type { TrainingEntry } from '../core/missions/catalogue';
import { mountScreen } from './screenHandle';
import { button, field, h, keyCap, menuKeys, shell } from './kit';
import { formatDuration, type MissionProgress } from './missions';

/** The first lesson not yet done (all done: none). */
export function nextLesson(lessons: readonly TrainingEntry[], progress: Readonly<Record<string, MissionProgress>>): TrainingEntry | undefined {
  return lessons.find((l) => !progress[l.id]?.completed);
}

export function createTrainingList(
  container: HTMLElement,
  opts: { lessons: readonly TrainingEntry[]; progress: Readonly<Record<string, MissionProgress>> },
  cb: { onSelect(id: string): void; onBack(): void }
): ScreenHandle {
  const done = opts.lessons.filter((l) => opts.progress[l.id]?.completed).length;
  const next = nextLesson(opts.lessons, opts.progress);
  const s = shell({
    title: 'Flight School',
    eyebrow: `Bhisiana AFS · ${done} of ${opts.lessons.length} lessons done`,
    sub: 'Four short lessons with an instructor on the radio. Each one tells you what to press and lights up the button on screen.',
    back: { onClick: () => cb.onBack() },
  });
  s.root.classList.add('tj-training');
  const tiles = opts.lessons.map((l) => {
    const p = opts.progress[l.id];
    const status = p?.completed
      ? h('span', { className: 'tj-badge tj-badge--ok', text: p.bestSec !== undefined ? `Done · ${formatDuration(p.bestSec)}` : 'Done' })
      : l === next
        ? h('span', { className: 'tj-op-first', text: done === 0 ? 'Start here' : 'Next' })
        : h('span', { className: 'tj-badge', text: `~${l.minutes} min` });
    const tile = h(
      'button',
      { className: `tj-card tj-lesson${l === next ? ' tj-lesson--next' : ''}`, attrs: { type: 'button', 'data-lesson': l.id } },
      h('span', { className: 'tj-lesson-num', text: String(l.lesson) }),
      h(
        'span',
        { className: 'tj-lesson-main' },
        h('span', { className: 'tj-lesson-top' }, h('span', { className: 'tj-lesson-title', text: l.title }), status),
        h('span', { className: 'tj-lesson-blurb', text: l.blurb }),
        h('span', { className: 'tj-lesson-skills' }, ...l.skills.map((k) => h('span', { className: 'tj-chip', text: k })))
      )
    );
    tile.addEventListener('click', () => cb.onSelect(l.id));
    return tile;
  });
  s.body.append(h('div', { className: 'tj-lessons' }, ...tiles));
  const handle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => cb.onBack(), { initialFocus: tiles[next ? opts.lessons.indexOf(next) : 0] });
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}

export interface LessonKeys {
  pitch: [string, string];
  roll: [string, string];
  throttle: [string, string];
  afterburner: string;
  camera: string;
}

export function createLessonBriefing(
  container: HTMLElement,
  opts: { lesson: TrainingEntry; total: number; keys: LessonKeys },
  cb: { onStart(): void; onBack(): void }
): ScreenHandle {
  const l = opts.lesson;
  const s = shell({ title: l.title, eyebrow: `Flight School · Lesson ${l.lesson} of ${opts.total} · about ${l.minutes} minutes`, back: { label: 'Flight School', onClick: () => cb.onBack() }, crumb: ['Flight School', 'Briefing'] });
  s.root.classList.add('tj-briefing');
  const k = opts.keys;
  const keyRow = (keys: string[], text: string): HTMLElement => h('div', { className: 'tj-row' }, ...keys.map((x) => keyCap(x)), h('span', { text }));
  const basics = h(
    'div',
    { className: 'tj-stack', attrs: { style: 'gap: 6px' } },
    keyRow([k.pitch[0], k.pitch[1]], 'nose down / up'),
    keyRow([k.roll[0], k.roll[1]], 'roll left / right'),
    keyRow([k.throttle[0], k.throttle[1]], 'throttle up / down'),
    keyRow([k.afterburner], 'afterburner (hold)'),
    keyRow([k.camera], 'change the view')
  );
  s.body.append(
    h(
      'div',
      { className: 'tj-cols' },
      h(
        'div',
        { className: 'tj-stack' },
        field('What happens', h('p', { text: l.situation, attrs: { style: 'margin:0' } })),
        field('You will learn', h('div', { className: 'tj-lesson-skills' }, ...l.skills.map((x) => h('span', { className: 'tj-chip', text: x }))))
      ),
      h(
        'div',
        { className: 'tj-stack' },
        field('The basic keys', basics),
        h('p', { className: 'tj-note', text: 'Everything else is on the buttons down the left of the screen: they show their keys, and the one the lesson wants glows gold.' })
      )
    )
  );
  s.actions.append(button('Start lesson', () => cb.onStart(), ['primary', 'big'], { 'data-action': 'start' }));
  const handle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => cb.onBack());
  return { ...handle, destroy: () => { release(); handle.destroy(); } };
}
