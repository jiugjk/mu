import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { clmServer, type ClmServerState } from '@/common/kyrn/clm';
import { isSafeEndpoint } from '@/common/kyrn/models';
import { formatNumber } from '@/renderer/services/i18n/format';
import { formatNameList } from '@/renderer/services/i18n/list';
import MuErrorMessage from '../fields/MuErrorMessage';
import { toMuError, type MuError } from '../fields/muError';
import { StatusDot, type DotState } from '../providers/parts';
import styles from './sections.module.css';

type ClmServerCheckProps = {
  /** The judge's address as typed; empty is clm-serve's default on this machine. */
  baseUrl: string;
  /** The model the judge asks for. */
  model: string;
  /** A key is saved for the judge, or typed and about to be. */
  keySet: boolean;
};

/**
 * How the CLM server at a judge's address is: asked when the panel opens, when a typed address has stayed the same
 * for a moment, and on request. It says whether the server answers, whether its encoder does, whether it serves the
 * model the judge asks for and whether it wants a key. Nothing here is saved.
 */
export default function ClmServerCheck({ baseUrl, model, keySet }: ClmServerCheckProps) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<ClmServerState>();
  const [problem, setProblem] = useState<MuError>();
  const [checking, setChecking] = useState(false);
  // Only the answer to the latest question is shown: an address being typed asks many.
  const asked = useRef(0);
  const check = useCallback(async () => {
    const ask = ++asked.current;
    setChecking(true);
    setProblem(undefined);
    try {
      const next = unwrap(await kyrnBridge.clmCheck.invoke({ baseUrl }));
      if (ask === asked.current) setState(next);
    } catch (error) {
      if (ask === asked.current) {
        setState(undefined);
        setProblem(toMuError(error));
      }
    } finally {
      if (ask === asked.current) setChecking(false);
    }
  }, [baseUrl]);
  // The address field shows the rule an address breaks; such an address is not asked.
  const valid = !baseUrl || isSafeEndpoint(baseUrl);
  useEffect(() => {
    if (!valid) return undefined;
    const timer = setTimeout(() => void check(), 500);
    return () => {
      clearTimeout(timer);
      asked.current += 1;
      setChecking(false);
    };
  }, [check, valid]);
  if (!valid) return null;

  const listed = (names: string[]) => formatNameList(names, i18n.language);
  // While a check runs, what the last address said is not shown as this one's.
  const shown = checking ? undefined : state;
  const failed = checking ? undefined : problem;
  let dot: DotState = 'busy';
  let status = t('mu.judges.clm.status.checking');
  if (failed) {
    dot = 'attention';
    status = t('mu.judges.clm.status.failed');
  } else if (shown?.status === 'down') {
    dot = 'attention';
    status = t('mu.judges.clm.status.down', { address: clmServer(baseUrl) });
  } else if (shown?.status === 'encoderDown') {
    dot = 'attention';
    status = t('mu.judges.clm.status.encoderDown');
  } else if (shown && shown.models.length > 0 && !shown.models.includes(model)) {
    dot = 'attention';
    status = t('mu.judges.clm.status.model', { model, models: listed(shown.models) });
  } else if (shown?.keyRequired && !keySet) {
    dot = 'attention';
    status = t('mu.judges.clm.status.keyNeeded');
  } else if (shown) {
    dot = 'ready';
    status = t('mu.judges.clm.status.ready', {
      models: listed(shown.models),
      ms: formatNumber(shown.latencyMs, i18n.language),
    });
  }
  const running = shown && shown.status !== 'down' ? shown : undefined;
  return (
    <div className={styles.localJudge} data-testid='mu-clm-server'>
      <div className={styles.localJudgeStatus} data-testid='mu-clm-status' aria-live='polite'>
        <StatusDot state={dot} label={status} />
        <span>{status}</span>
      </div>
      {failed ? (
        <div className={styles.localJudgeProblem} role='alert'>
          <MuErrorMessage error={failed} />
        </div>
      ) : null}
      {running?.mock ? <div className={styles.localJudgeProblem}>{t('mu.judges.clm.status.mock')}</div> : null}
      {running?.keyRequired && keySet ? (
        <div className={styles.choiceHint}>{t('mu.judges.clm.status.keySaved')}</div>
      ) : null}
      <div className={styles.localJudgeActions}>
        <Button size='small' loading={checking} onClick={() => void check()}>
          {t('mu.judges.clm.check')}
        </Button>
      </div>
    </div>
  );
}
