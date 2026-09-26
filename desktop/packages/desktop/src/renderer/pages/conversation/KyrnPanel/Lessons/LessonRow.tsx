import React, { useState } from 'react';
import { Button, Input } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { flatLesson, LESSON_CHARS, type StoredLesson } from '@/common/kyrn/lessons';
import { formatDate, formatNumber } from '@/renderer/services/i18n/format';
import { ErrorNotice } from '../text';
import { codeSpans, repeatsLesson } from './model';
import { messageOf, type LessonEdit } from './useLessons';
import styles from './Lessons.module.css';

const KEY = 'common.kyrn.lessonsView';

type Mode = 'view' | 'edit' | 'retire';

/** Words of the lessons with their `code` spans shown as the chat shows inline code, never with the backticks. */
export function LessonText({ text }: { text: string }) {
  return (
    <>
      {codeSpans(text).map((part, index) =>
        part.code ? (
          <code key={index} className={styles.code}>
            {part.text}
          </code>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
}

/**
 * One lesson: its kind, what to do, how often it was brought into a turn and followed, and when it applies, unless
 * that only says the lesson again. It opens to where it came from and, while it is in use, to rewording or retiring
 * it: the new words or the retirement are one more line in the file. Retiring asks once, in the row.
 */
export default function LessonRow({
  lesson,
  open,
  onToggle,
  onChange,
}: {
  lesson: StoredLesson;
  open: boolean;
  onToggle: () => void;
  onChange: (edit: LessonEdit) => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const active = lesson.status === 'active';
  const updated = new Date(lesson.updated);
  const where = [
    t(`${KEY}.origins.${lesson.source.origin}`),
    Number.isNaN(updated.getTime()) ? '' : t(`${KEY}.updated`, { date: formatDate(updated, language) }),
  ].filter(Boolean);

  const run = async (edit: LessonEdit) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await onChange(edit);
      setMode('view');
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const back = () => {
    setMode('view');
    setFailure(undefined);
  };
  // A row opens again as it first did, not in the middle of an edit left behind.
  const toggle = () => {
    if (open && !busy) back();
    onToggle();
  };

  return (
    <li className={styles.row} data-testid='mu-lesson' data-lesson={lesson.id} data-status={lesson.status}>
      <Button type='text' long className={styles.rowButton} aria-expanded={open} onClick={toggle}>
        <span className={styles.rowLesson}>
          <span className={styles.kind}>{t(`${KEY}.kinds.${lesson.kind}`)}</span>
          {lesson.scope.cwd === undefined ? <span className={styles.mark}>{t(`${KEY}.everywhere`)}</span> : null}
          {active ? null : <span className={styles.mark}>{t(`${KEY}.status.${lesson.status}`)}</span>}
          <span dir='auto' data-testid='mu-lesson-text'>
            <LessonText text={lesson.lesson} />
          </span>
        </span>
        <span className={styles.rowMeta}>
          {repeatsLesson(lesson.trigger, lesson.lesson) ? null : (
            <span className={styles.trigger} dir='auto' data-testid='mu-lesson-trigger'>
              <LessonText text={lesson.trigger} />
            </span>
          )}
          <span className={styles.uses} data-testid='mu-lesson-uses'>
            {t(`${KEY}.uses`, {
              recalled: formatNumber(lesson.uses.recalled, language),
              applied: formatNumber(lesson.uses.applied, language),
            })}
          </span>
        </span>
      </Button>
      {open ? (
        <div className={styles.detail}>
          <p className={styles.detailLine}>{where.join(' · ')}</p>
          {failure !== undefined ? <ErrorNotice title={t(`${KEY}.saveFailed`)} detail={failure} /> : null}
          {active && mode === 'view' ? (
            <div className={styles.actions}>
              <Button
                size='mini'
                onClick={() => {
                  setDraft(lesson.lesson);
                  setFailure(undefined);
                  setMode('edit');
                }}
              >
                {t('common.edit')}
              </Button>
              <Button
                size='mini'
                onClick={() => {
                  setFailure(undefined);
                  setMode('retire');
                }}
              >
                {t(`${KEY}.retire`)}
              </Button>
            </div>
          ) : null}
          {active && mode === 'edit' ? (
            <div className={styles.editor}>
              <Input.TextArea
                autoFocus
                autoSize={{ minRows: 2, maxRows: 6 }}
                maxLength={LESSON_CHARS}
                value={draft}
                onChange={setDraft}
                aria-label={t(`${KEY}.editLabel`)}
              />
              <div className={styles.actions}>
                <Button
                  size='mini'
                  type='primary'
                  loading={busy}
                  disabled={!flatLesson(draft)}
                  onClick={() => void run({ id: lesson.id, action: 'edit', lesson: draft })}
                >
                  {t('common.save')}
                </Button>
                <Button size='mini' disabled={busy} onClick={back}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
          {active && mode === 'retire' ? (
            <div className={styles.editor}>
              <p className={styles.confirm}>{t(`${KEY}.retireConfirm`)}</p>
              <div className={styles.actions}>
                <Button
                  size='mini'
                  type='primary'
                  loading={busy}
                  onClick={() => void run({ id: lesson.id, action: 'retire' })}
                >
                  {t(`${KEY}.retire`)}
                </Button>
                <Button size='mini' disabled={busy} onClick={back}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
