import React from 'react';
import { Input, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { isSafeEndpoint } from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import AionSelect from '@/renderer/components/base/AionSelect';
import { formatNumber } from '@/renderer/services/i18n/format';
import type { Draft } from '../draft';
import ChoiceTile from '../fields/ChoiceTile';
import Row from '../fields/Row';
import fieldStyles from '../fields/fields.module.css';
import {
  choiceOf,
  choose,
  JEV_ACCESS,
  JUDGE_CHOICES,
  type JevAccess,
  type JudgeChoice,
  jevKeyVariable,
  kindOf,
  profileFor,
  withJevAccess,
} from '../judgeChoice';
import SectionShell, { Card, GroupTitle } from './SectionShell';
import LocalJudgePanel from './LocalJudgePanel';
import styles from './sections.module.css';

type JudgesSectionProps = {
  draft: Draft;
  base: KyrnSettings;
  onChange: (change: (settings: KyrnSettings) => KyrnSettings) => void;
  onKey: (variable: string, value: string) => void;
};

/**
 * The judges page. First the choice most people make once: which judge answers the small questions mu asks while it
 * works, and under it the one thing that choice needs (Jev a key, Laya the one-click panel). Below it the judge tiers:
 * the order in which several judges are asked, and what each one needs.
 */
export default function JudgesSection({ draft, base, onChange, onKey }: JudgesSectionProps) {
  const { t } = useTranslation();
  return (
    <SectionShell id='judges' title={t('mu.sections.judges')} description={t('mu.judges.intro')}>
      <JudgeChoices draft={draft} onChange={onChange} onKey={onKey} />
      <JudgeTiers draft={draft} base={base} onChange={onChange} onKey={onKey} />
    </SectionShell>
  );
}

type JudgeChoicesProps = Pick<JudgesSectionProps, 'draft' | 'onChange' | 'onKey'>;

/** The choice itself: which judge answers the small questions, and the one thing that choice needs. */
export function JudgeChoices({ draft, onChange, onKey }: JudgeChoicesProps) {
  const { t } = useTranslation();
  const { settings } = draft;
  const current = choiceOf(settings);
  return (
    <>
      <div className={styles.choices} role='radiogroup' aria-label={t('mu.judges.choose')}>
        {JUDGE_CHOICES.map((choice) => (
          <JudgeChoiceTile
            key={choice}
            choice={choice}
            active={current === choice}
            onPick={() => onChange((now) => choose(now, choice))}
          >
            {current === choice ? <ChoiceBody choice={choice} draft={draft} onKey={onKey} /> : null}
          </JudgeChoiceTile>
        ))}
      </div>
      {current === undefined ? <div className={styles.meta}>{t('mu.judges.custom')}</div> : null}
    </>
  );
}

type TileProps = { choice: JudgeChoice; active: boolean; onPick: () => void; children?: React.ReactNode };

/** One of the three judge choices, worded from the mu i18n module. */
export function JudgeChoiceTile({ choice, active, onPick, children }: TileProps) {
  const { t } = useTranslation();
  return (
    <ChoiceTile
      testId={`mu-judge-choice-${choice}`}
      title={t(`mu.judges.choices.${choice}.title`)}
      tag={t(`mu.judges.choices.${choice}.tag`)}
      description={t(`mu.judges.choices.${choice}.description`)}
      active={active}
      onPick={onPick}
    >
      {children}
    </ChoiceTile>
  );
}

type BodyProps = {
  choice: JudgeChoice;
  draft: Draft;
  onKey: JudgesSectionProps['onKey'];
};

/** The one thing a choice needs: Jev a key, Laya to be installed and running (one click each). */
export function ChoiceBody({ choice, draft, onKey }: BodyProps) {
  const { t } = useTranslation();
  const { settings } = draft;
  const name = profileFor(settings, choice);
  const judge = name ? settings.judges[name] : undefined;

  if (choice === 'jev') {
    const variable = jevKeyVariable(judge);
    const set = settings.keys[variable];
    return (
      <div className={styles.choiceField}>
        <label className={styles.choiceLabel}>
          {t('mu.apiKey')}
          <Tag size='small'>{t(set ? 'mu.keyState.set' : 'mu.keyState.none')}</Tag>
        </label>
        <Input.Password
          className={styles.choiceInput}
          aria-label={t('mu.apiKey')}
          autoComplete='new-password'
          value={draft.judgeKeys[variable] ?? ''}
          placeholder={set ? t('mu.keyKeep') : t('mu.judges.keyPlaceholder')}
          onChange={(value) => onKey(variable, value)}
        />
        <div className={styles.choiceHint}>{t('mu.keyHelp')}</div>
      </div>
    );
  }

  return (
    <div className={styles.choiceField}>
      <LocalJudgePanel />
      <div className={styles.choiceHint}>
        {t('mu.judges.localAddress', { address: judge?.baseUrl || t('mu.judges.endpointDefault') })}
      </div>
    </div>
  );
}

/**
 * The judge tiers, under the choice: the order, by the judges' names (Jev, Laya), then a group per judge in that order
 * with what it needs. Jev: the way it is reached and its model. The one thing a judge needs to run (Jev's key, Laya's
 * install) is asked for in the choice above when it is the judge chosen there, the first; a judge further down the
 * order needs it here, where it is the only place. A judge of another kind (a model as judge, a self-hosted service)
 * goes by the name it was given.
 */
function JudgeTiers({ draft, base, onChange, onKey }: JudgesSectionProps) {
  const { t, i18n } = useTranslation();
  const { settings } = draft;
  const nameOf = (profile: string): string => {
    const kind = kindOf(settings.judges[profile]);
    return kind ? t(`mu.judges.choices.${kind}.title`) : profile;
  };
  // Every judge in the order, and Jev and Laya when they are not in it yet.
  const offered = [
    ...settings.tiers,
    ...JUDGE_CHOICES.filter((choice) => !settings.tiers.some((name) => kindOf(settings.judges[name]) === choice))
      .map((choice) => profileFor(settings, choice))
      .filter((name): name is string => name !== undefined),
  ];
  return (
    <div className={styles.stack} data-testid='mu-judge-tiers'>
      <div className={styles.groupHead}>
        <GroupTitle>{t('mu.sections.judgeTiers')}</GroupTitle>
        <div className={styles.groupHelp}>{t('mu.judges.tiersHelp')}</div>
      </div>
      <Card>
        <Row
          title={t('mu.judges.order')}
          help={t('mu.judges.orderHelp')}
          modified={base.tiers.join() !== settings.tiers.join()}
        >
          <AionSelect
            mode='multiple'
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.order')}
            value={settings.tiers}
            onChange={(tiers: string[]) => tiers.length && onChange((now) => ({ ...now, tiers }))}
            options={offered.map((name) => ({ value: name, label: nameOf(name) }))}
          />
        </Row>
      </Card>
      {settings.tiers.map((name, index) => {
        const kind = kindOf(settings.judges[name]);
        const summary =
          kind === 'local'
            ? t('mu.judges.types.localHelp')
            : kind === undefined
              ? t('mu.judges.customTier')
              : undefined;
        return (
          <Card
            key={`${index}:${name}`}
            testId={`mu-judge-tier-${index}`}
            title={t('mu.judges.tierTitle', { index: formatNumber(index + 1, i18n.language), name: nameOf(name) })}
            summary={summary}
          >
            {kind === 'jev' ? (
              <JevFields draft={draft} base={base} index={index} onChange={onChange} onKey={onKey} />
            ) : kind === 'local' && index > 0 ? (
              // The first judge is the one chosen above, whose choice installs and starts it.
              <div className={styles.tierPanel}>
                <LocalJudgePanel />
              </div>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}

/** TypeSafe's own System One address, shown when a direct TypeSafe judge has no address of its own yet. */
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Jev in the order: how it is reached and its model, and its key when it is not the judge chosen on the judges page. */
function JevFields({ draft, base, index, onChange, onKey }: JudgesSectionProps & { index: number }) {
  const { t } = useTranslation();
  const { settings } = draft;
  const name = settings.tiers[index];
  const judge = settings.judges[name];
  const access = judge.type as JevAccess;
  const before = base.judges[base.tiers[index] ?? ''];
  const variable = jevKeyVariable(judge);
  // The first judge's key is asked for in the choice above.
  const keyHere = index > 0;
  const baseUrlUnsafe = Boolean(judge.baseUrl) && !isSafeEndpoint(judge.baseUrl);
  return (
    <>
      <Row
        title={t('mu.judges.type')}
        help={t(`mu.judges.types.${access}Help`)}
        modified={before !== undefined && before.type !== judge.type}
      >
        <AionSelect
          size='small'
          className={fieldStyles.wide}
          aria-label={t('mu.judges.type')}
          value={access}
          onChange={(next: JevAccess) => onChange((now) => withJevAccess(now, index, next))}
          options={JEV_ACCESS.map((value) => ({ value, label: t(`mu.judges.access.${value}`) }))}
        />
      </Row>
      <Row
        title={t('mu.judges.model')}
        modified={base.judges[name] !== undefined && base.judges[name].model !== judge.model}
      >
        <Input
          size='small'
          className={fieldStyles.wide}
          aria-label={t('mu.judges.model')}
          value={judge.model}
          onChange={(model) =>
            onChange((now) => ({ ...now, judges: { ...now.judges, [name]: { ...now.judges[name], model } } }))
          }
        />
      </Row>
      {access === 'typesafe' ? (
        <Row
          title={t('mu.judges.baseUrl')}
          help={baseUrlUnsafe ? undefined : t('mu.judges.baseUrlHelp')}
          problem={baseUrlUnsafe ? t('mu.endpointRule') : undefined}
          modified={base.judges[name] !== undefined && base.judges[name].baseUrl !== judge.baseUrl}
        >
          <Input
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.judges.baseUrl')}
            placeholder={TYPESAFE_ENDPOINT}
            status={baseUrlUnsafe ? 'error' : undefined}
            value={judge.baseUrl}
            onChange={(baseUrl) =>
              onChange((now) => ({ ...now, judges: { ...now.judges, [name]: { ...now.judges[name], baseUrl } } }))
            }
          />
        </Row>
      ) : null}
      {keyHere ? (
        <Row
          title={t('mu.apiKey')}
          help={t('mu.keyHelp')}
          modified={Boolean(draft.judgeKeys[variable])}
          badges={<Tag size='small'>{t(settings.keys[variable] ? 'mu.keyState.set' : 'mu.keyState.none')}</Tag>}
        >
          <Input.Password
            size='small'
            className={fieldStyles.wide}
            aria-label={t('mu.apiKey')}
            autoComplete='new-password'
            value={draft.judgeKeys[variable] ?? ''}
            placeholder={settings.keys[variable] ? t('mu.keyKeep') : t('mu.judges.keyPlaceholder')}
            onChange={(value) => onKey(variable, value)}
          />
        </Row>
      ) : null}
    </>
  );
}
