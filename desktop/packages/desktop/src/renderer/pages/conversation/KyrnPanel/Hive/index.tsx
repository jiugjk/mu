import React, { useEffect, useMemo, useState } from 'react';
import { Button, Collapse, Empty, Pagination, Select, Tabs, Tag } from '@arco-design/web-react';
import { ArrowRight, Bee } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { Activity } from '@/common/kyrn/types';
import type { HiveFocusRequest } from '../focus';
import { str } from '../activity';
import { buildHiveRuns, endedRuns } from './activity';
import BeeAvatar from './BeeAvatar';
import BeeInspector from './BeeInspector';
import styles from './Hive.module.css';
import { useClock } from '../clock';
import { settledBee, swarmSummary } from './HiveToolCard';

export { default as HiveToolCard } from './HiveToolCard';

export default function Hive({ events, focus }: { events: Activity[]; focus?: HiveFocusRequest }) {
  const { t } = useTranslation();
  const clock = useClock();
  const runs = useMemo(() => buildHiveRuns(events), [events]);
  const ended = useMemo(() => endedRuns(events), [events]);
  const [runId, setRunId] = useState<string>();
  const [beeName, setBeeName] = useState<string>();
  const [tab, setTab] = useState('flow');
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (!focus) return;
    setRunId(focus.runId);
    setBeeName(focus.beeName);
    setTab(focus.beeName ? 'context' : 'flow');
    setPage(1);
  }, [focus]);
  const run = runId ? runs.find((item) => item.id === runId) : runs[0];
  const running = run ? !ended.has(run.id) : false;
  const bees = (run?.snapshot?.bees ?? []).map((bee) => settledBee(bee, running));
  const selected = bees.find((bee) => bee.name === beeName);
  const deliveries =
    run?.deliveries.filter((delivery) => !beeName || delivery.from === beeName || delivery.to === beeName) ?? [];
  const selectBee = (name: string) => {
    setRunId(run?.id);
    setBeeName(name);
    setTab('context');
    setPage(1);
  };
  return (
    <div className={styles.hive}>
      {(runs.length > 1 || (runId && !run)) && (
        <Select
          aria-label={t('common.kyrn.hiveView.runs')}
          value={run?.id}
          placeholder={t('common.kyrn.hiveView.runs')}
          options={runs.map((item) => ({
            value: item.id,
            label: `${clock(item.at)} · ${(item.goal || item.snapshot?.title || t('common.kyrn.hiveView.title')).slice(0, 80)}`,
          }))}
          onChange={(value) => {
            setRunId(value);
            setBeeName(undefined);
            setPage(1);
            setTab('flow');
          }}
        />
      )}
      {!run ? (
        <Empty description={t(runId ? 'common.kyrn.hiveView.waitingRun' : 'common.kyrn.empty')} />
      ) : (
        <>
          <div className={styles.cardHeader}>
            <span className={styles.brandIcon}>
              <Bee size={22} />
            </span>
            <div className='min-w-0 flex-1'>
              <h3 className={styles.beeName}>{t('common.kyrn.hiveView.title')}</h3>
              <div className={styles.hint}>
                {run.snapshot ? swarmSummary(t, bees, running) : t('common.kyrn.hiveView.pending')}
              </div>
            </div>
          </div>
          <Collapse bordered={false} className={styles.collapse}>
            <Collapse.Item
              name='goal'
              header={
                <span className={styles.goal}>
                  {run.goal || run.snapshot?.title || t('common.kyrn.hiveView.focus')}
                </span>
              }
            >
              <div className={styles.wrap}>{run.goal || run.snapshot?.title}</div>
            </Collapse.Item>
          </Collapse>
          <div className={styles.hint}>
            {t('common.kyrn.hiveView.snapshot')} ·{' '}
            {t('common.kyrn.hiveView.updated', { time: clock(run.snapshot?.now || run.at) })}
          </div>
          {!run.snapshot &&
            run.assignments.map((bee, index) => (
              <div key={`${index}:${bee.name}`} className={styles.pendingBee}>
                <BeeAvatar name={bee.name} small />
                <span className={styles.wrap}>{bee.name}</span>
              </div>
            ))}
          <Tabs
            activeTab={tab}
            size='small'
            onChange={(value) => {
              setTab(value);
              setPage(1);
            }}
          >
            <Tabs.TabPane key='flow' title={t('common.kyrn.hiveView.deliveries')} />
            <Tabs.TabPane key='context' title={t('common.kyrn.hiveView.context')} />
          </Tabs>
          {tab === 'context' ? (
            selected ? (
              <BeeInspector
                key={`${run.id}:${selected.name}`}
                bee={selected}
                focus={run.assignments[selected.assignmentIndex]?.focus}
                events={run.events}
              />
            ) : (
              <p className={styles.hint}>
                {t(beeName ? 'common.kyrn.hiveView.beeMissing' : 'common.kyrn.hiveView.selectBee')}
              </p>
            )
          ) : (
            <>
              {beeName && (
                <div className={styles.flowFilter}>
                  <span>{t('common.kyrn.hiveView.beeFlow', { name: beeName })}</span>
                  <Button
                    type='text'
                    size='mini'
                    onClick={() => {
                      setBeeName(undefined);
                      setPage(1);
                    }}
                  >
                    {t('common.kyrn.hiveView.allFlow')}
                  </Button>
                </div>
              )}
              {!deliveries.length && <p className={styles.hint}>{t('common.kyrn.hiveView.noDeliveries')}</p>}
              {deliveries
                .toReversed()
                .slice((page - 1) * 20, page * 20)
                .map((delivery) => (
                  <article key={delivery.id} className={styles.delivery}>
                    <div className={styles.route}>
                      <BeeAvatar
                        name={delivery.from}
                        status={bees.find((bee) => bee.name === delivery.from)?.status}
                        small
                      />
                      <Button
                        type='text'
                        size='mini'
                        className={styles.routeName}
                        disabled={!bees.some((bee) => bee.name === delivery.from)}
                        onClick={() => selectBee(delivery.from)}
                      >
                        {delivery.from || t('common.kyrn.hiveView.unknownSource')}
                      </Button>
                      <ArrowRight size={16} />
                      <Button
                        type='text'
                        size='mini'
                        className={styles.routeName}
                        disabled={!bees.some((bee) => bee.name === delivery.to)}
                        onClick={() => selectBee(delivery.to)}
                      >
                        {delivery.to}
                      </Button>
                    </div>
                    <div className={styles.hint}>{t('common.kyrn.event.hive.delivery')}</div>
                    <div className={styles.finding}>{delivery.text || t('common.kyrn.hiveView.noteMissing')}</div>
                  </article>
                ))}
              {deliveries.length > 20 && (
                <Pagination simple current={page} pageSize={20} total={deliveries.length} onChange={setPage} />
              )}
              <Collapse bordered={false} className={styles.collapse}>
                <Collapse.Item name='board' header={`${t('common.kyrn.hiveView.board')} · ${run.notes.length}`}>
                  {!run.notes.length && <p className={styles.hint}>{t('common.kyrn.hiveView.noNotes')}</p>}
                  {run.notes.map((note) => (
                    <article key={note.id} className={styles.delivery}>
                      <div className='font-500'>{note.from}</div>
                      <div className={styles.finding}>{note.text}</div>
                    </article>
                  ))}
                </Collapse.Item>
                <Collapse.Item name='gates' header={`${t('common.kyrn.hiveView.audit')} · ${run.gates.length}`}>
                  <GateRecords key={run.id} events={run.gates} />
                </Collapse.Item>
              </Collapse>
            </>
          )}
        </>
      )}
    </div>
  );
}

function GateRecords({ events }: { events: Activity[] }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  return (
    <>
      <Collapse bordered={false} className={styles.collapse}>
        {events
          .toReversed()
          .slice((page - 1) * 20, page * 20)
          .map((event) => {
            const p = event.payload;
            const allowed = p.publish ?? p.deliver;
            return (
              <Collapse.Item
                key={event.id}
                name={event.id}
                header={
                  <span className={styles.wrap}>
                    {str(p.bee) || str(p.from)}
                    {p.to ? ` → ${str(p.to)}` : ''}{' '}
                    {typeof allowed === 'boolean' && (
                      <Tag>{t(allowed ? 'common.kyrn.passed' : 'common.kyrn.filtered')}</Tag>
                    )}
                  </span>
                }
              >
                {/* JSON reads left to right in every app language, including fa-IR. */}
                <pre className={styles.recordText} dir='ltr'>
                  {JSON.stringify(p, null, 2)}
                </pre>
              </Collapse.Item>
            );
          })}
      </Collapse>
      {events.length > 20 && (
        <Pagination simple current={page} pageSize={20} total={events.length} onChange={setPage} />
      )}
    </>
  );
}
