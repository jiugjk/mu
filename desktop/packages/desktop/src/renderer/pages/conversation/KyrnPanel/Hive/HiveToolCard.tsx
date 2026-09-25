import React from 'react';
import { Button } from '@arco-design/web-react';
import { Right } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { isBeeActive, type HiveBee, type HiveToolData } from '@/common/kyrn/hive';
import type { NormalizedToolStatus } from '@/common/chat/normalizeToolCall';
import { requestHiveFocus } from '../focus';
import BeeAvatar from './BeeAvatar';
import { beeActivityText, beeErrorText, swarmTitleText } from './codes';
import HiveMiniature from './Graph/Miniature';
import styles from './Hive.module.css';

/**
 * A sub-agent run in the transcript: one line per sub-agent, never the tool's payload. Each line says who it is (its
 * name and the role it was given) and what it is doing right now — the tool it is running, what it is thinking about,
 * or, once it is back, the first of what it reported. The header carries the run's map in miniature, and opens the
 * run in the panel's hive tab; a line opens that sub-agent there.
 */

/**
 * What a sub-agent's line says on its right: its own words, in the app language where the harness gave a code. The
 * work panel's hive tab says the same on its rows. `thinking` is its thinking level, shown beside its model, never as
 * what it is doing.
 *
 * A read or a search takes milliseconds and a model reply seconds, so a working sub-agent is nearly always caught
 * waiting on its model, with no tool running and nothing said yet. Its status alone would then read "thinking" for
 * the whole run; its last step beside it changes as it works.
 */
export function beeLine(t: ReturnType<typeof useTranslation>['t'], bee: HiveBee, language?: string | null): string {
  if (bee.error) return beeErrorText(t, bee, language);
  if (bee.tool) return bee.tool.summary || bee.tool.name;
  if (bee.said) return bee.said;
  const status = t(bee.status === 'unknown' ? 'common.kyrn.hiveView.unknown' : `common.kyrn.beeStatus.${bee.status}`);
  const last = isBeeActive(bee.status) ? bee.recent.at(-1) : undefined;
  return last ? t('common.kyrn.hiveView.lastStep', { status, step: beeActivityText(t, last, language) }) : status;
}

export default function HiveToolCard({
  data,
  conversationId,
  runId,
  status,
}: {
  data: HiveToolData;
  conversationId?: string;
  runId: string;
  status: NormalizedToolStatus;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n?.language;
  const bees = data.snapshot?.bees;
  const open = (beeName?: string) => {
    if (conversationId) requestHiveFocus({ conversationId, runId, beeName });
  };
  const title = t(data.kind === 'delegate' ? 'common.kyrn.hiveView.agents' : 'common.kyrn.hiveView.title');
  const runTitle = data.snapshot ? swarmTitleText(t, data.snapshot) : data.goal;
  const summary = bees
    ? t('common.kyrn.hiveView.summary', {
        active: bees.filter((bee) => isBeeActive(bee.status)).length,
        done: bees.filter((bee) => bee.status === 'done').length,
        total: bees.length,
      })
    : t(status === 'running' || status === 'pending' ? 'common.kyrn.hiveView.pending' : 'common.kyrn.hiveView.unknown');

  return (
    <section className={styles.agents} aria-label={title} data-testid='swarm-tool-card'>
      <Button
        className={styles.agentsHeader}
        type='text'
        size='mini'
        disabled={!conversationId}
        onClick={() => open()}
        aria-label={t('common.kyrn.hiveView.open')}
      >
        <span className={styles.agentsTitle}>{title}</span>
        {data.snapshot && (
          <HiveMiniature kind={data.snapshot.kind} bees={data.snapshot.bees} latest={data.snapshot.latest} />
        )}
        <span className={styles.agentsSummary}>{summary}</span>
        <Right size={12} />
      </Button>
      {runTitle && (
        <div className={styles.agentsGoal} title={runTitle}>
          {runTitle}
        </div>
      )}
      <div className={styles.agentsList}>
        {data.names.map((name, index) => {
          const bee = bees?.[index];
          return (
            <Button
              key={`${index}:${name}`}
              type='text'
              size='mini'
              className={styles.agentRow}
              disabled={!conversationId}
              onClick={() => open(name)}
              aria-label={t('common.kyrn.hiveView.inspect', { name })}
            >
              <BeeAvatar name={name} status={bee?.status} small />
              <span className={styles.agentName}>{name}</span>
              {bee?.role && <span className={styles.agentRole}>{bee.role}</span>}
              <span className={bee?.error ? styles.agentFailed : styles.agentDoing}>
                {bee ? beeLine(t, bee, language) : t('common.kyrn.hiveView.pending')}
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}
