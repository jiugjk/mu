import type { StoredLesson } from '@/common/kyrn/lessons';
import type { Activity } from '@/common/kyrn/types';

/** What the harness says about lessons: one stored, brought into a turn, followed, retired, merged into another. */
export const MEMORY_EVENTS: ReadonlySet<string> = new Set([
  'memory.stored',
  'memory.recalled',
  'memory.applied',
  'memory.retired',
  'memory.merged',
]);

/** A session's lesson events, oldest first: each one has the file read again, and is news while the tab is not seen. */
export const memoryEvents = (events: readonly Activity[]): Activity[] =>
  events.filter((event) => MEMORY_EVENTS.has(event.kind));

/** The lessons in use, or every lesson of the project. */
export type LessonFilter = 'active' | 'all';

/** More rows than this, and the tab offers a search. */
export const SEARCH_AFTER = 20;

const byUse = (a: StoredLesson, b: StoredLesson): number =>
  b.uses.applied - a.uses.applied || b.updated.localeCompare(a.updated);

/**
 * The rows of a filter: the lessons in use, the most followed first, then the latest written or confirmed, as recall
 * ranks them. `all` lists the retired and replaced ones after them, in the same order.
 */
export function shownLessons(lessons: readonly StoredLesson[], filter: LessonFilter): StoredLesson[] {
  const active = lessons.filter((lesson) => lesson.status === 'active').toSorted(byUse);
  if (filter === 'active') return active;
  return [...active, ...lessons.filter((lesson) => lesson.status !== 'active').toSorted(byUse)];
}

/** A part of a lesson's words: plain text, or a `code` span, shown as the chat shows inline code. */
export type TextPart = { text: string; code: boolean };

/**
 * A lesson's words in parts, each `code` span apart, as Markdown reads them: a run of backticks opens a span and the
 * next run of as many closes it; a run left open is plain text. One space just inside both ends of a span is dropped.
 */
export function codeSpans(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let plain = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '`') {
      plain += text[index];
      index += 1;
      continue;
    }
    let open = index;
    while (text[open] === '`') open += 1;
    const fence = text.slice(index, open);
    // The next run of backticks exactly as long closes the span; a longer or shorter run is part of it.
    let close = -1;
    for (let at = text.indexOf('`', open); at >= 0; ) {
      let end = at;
      while (text[end] === '`') end += 1;
      if (end - at === fence.length) {
        close = at;
        break;
      }
      at = text.indexOf('`', end);
    }
    if (close < 0) {
      plain += fence;
      index = open;
      continue;
    }
    const inside = text.slice(open, close);
    const code = inside.startsWith(' ') && inside.endsWith(' ') && inside.trim() ? inside.slice(1, -1) : inside;
    if (plain) parts.push({ text: plain, code: false });
    plain = '';
    parts.push({ text: code, code: true });
    index = close + fence.length;
  }
  if (plain) parts.push({ text: plain, code: false });
  return parts;
}

/** The words as they read on screen: the code spans without their backticks, runs of white space as one space. */
export const shownText = (text: string): string =>
  codeSpans(text)
    .map((part) => part.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

/** Words to hold against others as they read: no backticks, even of a span cut open, and white space run together. */
const readable = (text: string): string => text.replace(/`+/g, '').replace(/\s+/g, ' ').trim();

/**
 * Whether a lesson's trigger only says the lesson again, and its line under the lesson would repeat it: the same words,
 * or the start of them as they read (a trigger cut from the lesson, perhaps inside a code span or before an ellipsis).
 */
export function repeatsLesson(trigger: string, lesson: string): boolean {
  if (trigger.trim() === lesson.trim()) return true;
  const start = readable(trigger)
    .replace(/(?:…|\.\.\.)$/u, '')
    .trimEnd();
  return readable(lesson).startsWith(start);
}

/** Whether every word searched for is in what the lesson says, when it applies, or the name of its kind. */
export function lessonMatches(lesson: StoredLesson, query: string, kindName: string): boolean {
  const text = `${lesson.lesson}\n${lesson.trigger}\n${kindName}`.toLocaleLowerCase();
  return query
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
