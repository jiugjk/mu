import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { LessonChange, LessonsView, StoredLesson } from '@/common/kyrn/lessons';
import type { Activity } from '@/common/kyrn/types';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import LessonsTab from '@/renderer/pages/conversation/KyrnPanel/Lessons';

type Answer = { ok: true; data: LessonsView } | { ok: false; error: string };

const { read, change } = vi.hoisted(() => ({
  read: vi.fn<(request: { conversationId: string }) => Promise<Answer>>(),
  change: vi.fn<(request: LessonChange) => Promise<Answer>>(),
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { lessons: { invoke: read }, lessonsChange: { invoke: change } },
  unwrap: (result: Answer) => {
    if (result.ok === false) throw new Error(result.error);
    return result.data;
  },
}));

const copy = common.kyrn.lessonsView;
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: { common } } }, interpolation: { escapeValue: false } });
});

const lesson = (id: string, extra: Partial<StoredLesson> = {}): StoredLesson => ({
  id,
  kind: 'correction',
  trigger: `When ${id} comes up`,
  lesson: `Do ${id}.`,
  scope: { cwd: '/work/app' },
  source: { origin: 'user' },
  status: 'active',
  uses: { recalled: 0, applied: 0 },
  created: '2026-09-20T00:00:00.000Z',
  updated: '2026-09-20T00:00:00.000Z',
  ...extra,
});
const answer = (lessons: StoredLesson[], project = '/work/app'): Answer => ({ ok: true, data: { project, lessons } });

let next = 0;
const event = (kind: string, payload: Record<string, unknown>): Activity => ({
  id: `event-${++next}`,
  at: Date.UTC(2026, 8, 23, 4, 0, next),
  kind,
  payload,
});

function Tab({ events = [], visible = true }: { events?: Activity[]; visible?: boolean }) {
  return (
    <I18nextProvider i18n={i18n}>
      <LessonsTab conversationId='conv-1' events={events} visible={visible} />
    </I18nextProvider>
  );
}
/** Let the bridge's answers land. */
const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
const rows = () => screen.queryAllByTestId('mu-lesson');
const row = (id: string) => rows().find((item) => item.dataset.lesson === id) as HTMLElement;
const open = (id: string) => fireEvent.click(within(row(id)).getByRole('button', { expanded: false }));

const pitfall = lesson('pitfall', {
  kind: 'pitfall',
  lesson: 'Run vitest with Node 24.',
  trigger: 'Running the desktop tests',
  source: { origin: 'outcome', session: 's', turn: 4 },
  uses: { recalled: 3, applied: 2 },
});
const everywhere = lesson('everywhere', {
  kind: 'preference',
  lesson: 'Answer in Chinese.',
  scope: {},
  uses: { recalled: 5, applied: 1 },
});
const retired = lesson('retired', { status: 'retired', uses: { recalled: 8, applied: 0 } });
const replaced = lesson('replaced', { status: 'superseded', kind: 'fact' });

beforeEach(() => {
  read.mockResolvedValue(answer([everywhere, retired, pitfall, replaced]));
  change.mockReset();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the lessons tab', () => {
  it('lists the lessons in use, the most followed first: kind, what to do, recalls and follows, when it applies', async () => {
    render(<Tab />);
    await settle();
    expect(read).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    expect(rows().map((item) => item.dataset.lesson)).toEqual(['pitfall', 'everywhere']);
    expect(screen.getByTestId('mu-lessons-count')).toHaveTextContent('2 lessons');

    const first = row('pitfall');
    expect(first).toHaveTextContent(copy.kinds.pitfall);
    expect(first).toHaveTextContent('Run vitest with Node 24.');
    expect(first).toHaveTextContent('Running the desktop tests');
    expect(within(first).getByTestId('mu-lesson-uses')).toHaveTextContent('Recalled 3 · Followed 2');
    expect(first).not.toHaveTextContent(copy.everywhere);
    // A lesson for every project says so.
    expect(row('everywhere')).toHaveTextContent(`${copy.kinds.preference}${copy.everywhere}Answer in Chinese.`);
  });

  it('adds the retired and replaced lessons under all, marked and greyed, without ways to change them', async () => {
    render(<Tab />);
    await settle();
    fireEvent.click(screen.getByRole('radio', { name: copy.all }));
    expect(rows().map((item) => item.dataset.lesson)).toEqual(['pitfall', 'everywhere', 'retired', 'replaced']);
    expect(row('retired')).toHaveAttribute('data-status', 'retired');
    expect(row('retired')).toHaveTextContent(copy.status.retired);
    expect(row('replaced')).toHaveTextContent(copy.status.superseded);
    expect(screen.getByTestId('mu-lessons-count')).toHaveTextContent('4 lessons');

    open('retired');
    expect(within(row('retired')).queryByRole('button', { name: common.edit })).not.toBeInTheDocument();
    expect(within(row('retired')).queryByRole('button', { name: copy.retire })).not.toBeInTheDocument();
  });

  it('opens a lesson to where it came from, and rewords it by appending its new text', async () => {
    const reworded = {
      ...pitfall,
      lesson: 'Run vitest with Node 24 first on PATH.',
      updated: '2026-09-23T05:00:00.000Z',
    };
    change.mockResolvedValue(answer([everywhere, retired, reworded, replaced]));
    render(<Tab />);
    await settle();

    open('pitfall');
    expect(row('pitfall')).toHaveTextContent(copy.origins.outcome);
    fireEvent.click(within(row('pitfall')).getByRole('button', { name: common.edit }));
    const box = within(row('pitfall')).getByRole('textbox', { name: copy.editLabel });
    expect(box).toHaveValue('Run vitest with Node 24.');
    fireEvent.change(box, { target: { value: 'Run vitest with Node 24 first on PATH.' } });
    await act(async () => {
      fireEvent.click(within(row('pitfall')).getByRole('button', { name: common.save }));
    });

    expect(change).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      id: 'pitfall',
      action: 'edit',
      lesson: 'Run vitest with Node 24 first on PATH.',
    });
    expect(row('pitfall')).toHaveTextContent('Run vitest with Node 24 first on PATH.');
    expect(within(row('pitfall')).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not save an empty text', async () => {
    render(<Tab />);
    await settle();
    open('pitfall');
    fireEvent.click(within(row('pitfall')).getByRole('button', { name: common.edit }));
    fireEvent.change(within(row('pitfall')).getByRole('textbox'), { target: { value: '  \n ' } });
    expect(within(row('pitfall')).getByRole('button', { name: common.save })).toBeDisabled();
  });

  it('retires a lesson after asking once in the row, and it leaves the lessons in use', async () => {
    change.mockResolvedValue(answer([everywhere, retired, { ...pitfall, status: 'retired' }, replaced]));
    render(<Tab />);
    await settle();

    open('pitfall');
    fireEvent.click(within(row('pitfall')).getByRole('button', { name: copy.retire }));
    expect(row('pitfall')).toHaveTextContent(copy.retireConfirm);
    expect(change).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(row('pitfall')).getByRole('button', { name: copy.retire }));
    });

    expect(change).toHaveBeenCalledWith({ conversationId: 'conv-1', id: 'pitfall', action: 'retire' });
    expect(rows().map((item) => item.dataset.lesson)).toEqual(['everywhere']);
  });

  it('keeps the lesson and says why when the change could not be written', async () => {
    change.mockResolvedValue({ ok: false, error: 'EACCES: permission denied' });
    render(<Tab />);
    await settle();
    open('pitfall');
    fireEvent.click(within(row('pitfall')).getByRole('button', { name: copy.retire }));
    await act(async () => {
      fireEvent.click(within(row('pitfall')).getByRole('button', { name: copy.retire }));
    });
    const alert = within(row('pitfall')).getByRole('alert');
    expect(alert).toHaveTextContent(copy.saveFailed);
    expect(alert).toHaveTextContent('EACCES: permission denied');
    expect(rows().map((item) => item.dataset.lesson)).toEqual(['pitfall', 'everywhere']);
  });

  it('reads the file only while shown, and again after each lesson event of the session', async () => {
    const { rerender } = render(<Tab visible={false} />);
    await settle();
    expect(read).not.toHaveBeenCalled();

    rerender(<Tab visible />);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    // Not a lesson event: nothing to read again.
    rerender(<Tab visible events={[event('board.update', {})]} />);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValue(answer([{ ...pitfall, uses: { recalled: 4, applied: 3 } }, everywhere]));
    rerender(<Tab visible events={[event('board.update', {}), event('memory.applied', { ids: ['pitfall'] })]} />);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(within(row('pitfall')).getByTestId('mu-lesson-uses')).toHaveTextContent('Recalled 4 · Followed 3');
  });

  it('says in quiet lines what the lessons did in this session, newest first', async () => {
    render(
      <Tab
        events={[
          event('memory.recalled', { ids: ['pitfall', 'everywhere'], turn: 1 }),
          event('memory.applied', { ids: ['pitfall'] }),
          event('memory.retired', { id: 'retired', reason: 'unused' }),
        ]}
      />
    );
    await settle();
    const notes = within(screen.getByTestId('mu-lessons-notes')).getAllByRole('listitem');
    expect(notes.map((note) => note.lastElementChild?.textContent)).toEqual([
      'Retired: Do retired. (recalled 8 times, never followed)',
      '1 lesson was followed',
      'This turn brought in 2 lessons',
    ]);
  });

  it('shows a lesson’s code spans as inline code, never its backticks', async () => {
    const snapshot = lesson('snapshot', {
      kind: 'fact',
      lesson: '当前根工作树没有 `desktop/`；调查桌面源码应使用 `.claude/worktrees/mu-sync/desktop/` 的已记录快照。',
      trigger: 'Reading the desktop sources from the root checkout with `rg`',
    });
    read.mockResolvedValue(answer([snapshot]));
    render(<Tab events={[event('memory.retired', { id: 'snapshot', reason: 'forgotten' })]} />);
    await settle();
    const text = within(row('snapshot')).getByTestId('mu-lesson-text');
    expect([...text.querySelectorAll('code')].map((code) => code.textContent)).toEqual([
      'desktop/',
      '.claude/worktrees/mu-sync/desktop/',
    ]);
    expect(row('snapshot').textContent).not.toContain('`');
    expect(within(row('snapshot')).getByTestId('mu-lesson-trigger').querySelector('code')).toHaveTextContent(/^rg$/);
    // A note names the lesson by its words, code and all; its whole on hover reads without backticks.
    const note = within(screen.getByTestId('mu-lessons-notes')).getAllByRole('listitem')[0];
    expect(note.querySelectorAll('code')).toHaveLength(2);
    expect(note.textContent).not.toContain('`');
    expect(note.lastElementChild?.getAttribute('title')).not.toContain('`');
  });

  it('leaves out a trigger that only says the lesson again, and keeps one in its own words', async () => {
    const same = lesson('same', {
      lesson: '当前根工作树没有 `desktop/`；调查桌面源码应使用 `.claude/worktrees/mu-sync/desktop/` 的快照。',
      trigger: '当前根工作树没有 `desktop/`；调查桌面源码应使用 `.claude/worktrees/mu-sync/desktop/` 的快照。',
      uses: { recalled: 2, applied: 1 },
    });
    const cut = lesson('cut', { lesson: 'Rerun these tests from the parent session.', trigger: 'Rerun these tests…' });
    read.mockResolvedValue(answer([same, cut, pitfall]));
    render(<Tab />);
    await settle();
    for (const id of ['same', 'cut']) expect(within(row(id)).queryByTestId('mu-lesson-trigger')).toBeNull();
    // What it counted still shows on the line.
    expect(within(row('same')).getByTestId('mu-lesson-uses')).toHaveTextContent('Recalled 2 · Followed 1');
    expect(within(row('pitfall')).getByTestId('mu-lesson-trigger')).toHaveTextContent('Running the desktop tests');
  });

  it('says so when there are no lessons, none in use, or no project folder', async () => {
    read.mockResolvedValue(answer([], ''));
    const { unmount } = render(<Tab />);
    await settle();
    expect(screen.getByText(copy.noProject)).toBeInTheDocument();
    expect(screen.getByTestId('mu-lessons-empty')).toHaveTextContent(copy.empty);
    unmount();

    read.mockResolvedValue(answer([retired]));
    render(<Tab />);
    await settle();
    expect(screen.queryByText(copy.noProject)).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-lessons-empty')).toHaveTextContent(copy.noneActive);
  });

  it('says when the lessons could not be read', async () => {
    read.mockResolvedValue({ ok: false, error: 'EISDIR: illegal operation on a directory' });
    render(<Tab />);
    await settle();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(copy.loadFailed);
    expect(alert).toHaveTextContent('EISDIR');
  });

  it('offers a search only past twenty rows, matching every word', async () => {
    read.mockResolvedValue(answer(Array.from({ length: 20 }, (_, index) => lesson(`rule-${index}`))));
    const { unmount } = render(<Tab />);
    await settle();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(copy.search)).not.toBeInTheDocument();
    unmount();

    read.mockResolvedValue(answer([...Array.from({ length: 20 }, (_, index) => lesson(`rule-${index}`)), pitfall]));
    render(<Tab />);
    await settle();
    fireEvent.change(screen.getByPlaceholderText(copy.search), { target: { value: 'NODE pitfall' } });
    expect(rows().map((item) => item.dataset.lesson)).toEqual(['pitfall']);
    expect(screen.getByTestId('mu-lessons-count')).toHaveTextContent('1 lesson');
    fireEvent.change(screen.getByPlaceholderText(copy.search), { target: { value: 'nothing like it' } });
    expect(screen.getByTestId('mu-lessons-empty')).toHaveTextContent(copy.noMatch);
  });
});
