import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Message, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import { LAYA_ONNX_DOWNLOAD_MB, LAYA_ONNX_PAGE, layaOnnxCommand } from '@/common/kyrn/layaOnnx';
import { LOCAL_JUDGE_DOWNLOAD_MB, type LocalJudgeAction, type LocalJudgeState } from '@/common/kyrn/localJudge';
import { formatNumber } from '@/renderer/services/i18n/format';
import { formatNameList } from '@/renderer/services/i18n/list';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { openExternalUrl } from '@/renderer/utils/platform';
import MuErrorMessage from '../fields/MuErrorMessage';
import { toMuError, type MuError } from '../fields/muError';
import { StatusDot, type DotState } from '../providers/parts';
import styles from './sections.module.css';

const UV_URL = 'https://docs.astral.sh/uv/getting-started/installation/';

/**
 * Laya on this machine: whether it is installed and running, and what can be done about it. Applies at once, outside
 * the save bar: it is a program, not a setting.
 *
 * On an Apple Silicon Mac (coreml) one click installs it after the person agrees to the download. Elsewhere (onnx) the
 * app never downloads the model: it links to Hugging Face, shows the folder the files go in, and checks and starts
 * them once they are there.
 *
 * `guide`: in the first-run guide, which sets Laya up; stopping it is for the settings.
 */
export default function LocalJudgePanel({ guide = false }: { guide?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const [modal, modalHolder] = Modal.useModal();
  const [state, setState] = useState<LocalJudgeState>();
  const [problem, setProblem] = useState<MuError>();
  const live = useRef(true);
  const read = useCallback(async () => {
    try {
      const next = unwrap(await kyrnBridge.localJudgeState.invoke());
      if (live.current) setState(next);
    } catch (error) {
      if (live.current) setProblem(toMuError(error));
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void read();
    return () => {
      live.current = false;
    };
  }, [read]);

  const task = state?.task;
  const busy = task?.phase === 'running';
  // The script moves on by itself: its state is read while it runs.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [busy, read]);

  const run = async (action: LocalJudgeAction, consent = false) => {
    setProblem(undefined);
    try {
      const next = unwrap(await kyrnBridge.localJudgeRun.invoke({ action, consent }));
      if (live.current) setState(next);
    } catch (error) {
      if (live.current) setProblem(toMuError(error));
    }
  };
  const install = () =>
    modal.confirm?.({
      title: t('mu.judges.laya.confirmTitle'),
      content: t('mu.judges.laya.confirmText', { size: formatNumber(LOCAL_JUDGE_DOWNLOAD_MB, i18n.language) }),
      okText: t('mu.judges.laya.confirmOk'),
      cancelText: t('common.cancel'),
      onOk: () => void run('setup', true),
    });

  if (!state)
    return problem ? (
      <div className={styles.choiceHint} role='alert'>
        <MuErrorMessage error={problem} />
      </div>
    ) : null;

  const onnx = state.runtime === 'onnx';
  const model = onnx ? state.model : undefined;
  const dot: DotState = busy ? 'busy' : state.running ? 'ready' : state.installed ? 'off' : 'attention';
  const status = busy
    ? t(onnx && task.action === 'start' ? 'mu.judges.laya.onnx.starting' : `mu.judges.laya.working.${task.action}`)
    : state.running
      ? t('mu.judges.laya.running')
      : state.installed
        ? t(onnx ? 'mu.judges.laya.onnx.stopped' : 'mu.judges.laya.stopped')
        : state.support === 'platform'
          ? t('mu.judges.laya.platform')
          : state.support === 'uv'
            ? t('mu.judges.laya.needsUv')
            : onnx
              ? t('mu.judges.laya.onnx.missing', { size: formatNumber(LAYA_ONNX_DOWNLOAD_MB, i18n.language) })
              : t('mu.judges.laya.missing');
  const failed = task?.phase === 'failed';
  const failure = !failed
    ? ''
    : task.problem
      ? t(`mu.judges.laya.onnx.problem.${task.problem}`, { port: new URL(state.url).port })
      : t(`mu.judges.laya.failed.${task.action}`);
  const getModel = onnx && state.support === 'ok' && !state.installed && !state.running;
  const command = model ? layaOnnxCommand(model.folder) : '';
  const copy = async () => {
    try {
      await copyText(command);
      Message.success(t('common.copySuccess'));
    } catch {
      Message.error(t('common.copyFailed'));
    }
  };

  return (
    <div className={styles.localJudge} data-testid='mu-laya'>
      {modalHolder}
      <div className={styles.localJudgeStatus} data-testid='mu-laya-status'>
        <StatusDot state={dot} label={status} />
        <span>{status}</span>
      </div>
      {getModel && model ? (
        <div className={styles.localJudgeModel} data-testid='mu-laya-model'>
          {model.missing.length && model.missing.length < 5 ? (
            <div>{t('mu.judges.laya.onnx.missingFiles', { files: formatNameList(model.missing, i18n.language) })}</div>
          ) : null}
          {model.wrong.length ? (
            <div className={styles.localJudgeProblem}>
              {t('mu.judges.laya.onnx.wrongFiles', { files: formatNameList(model.wrong, i18n.language) })}
            </div>
          ) : null}
          <div>{t('mu.judges.laya.onnx.folder', { folder: model.folder })}</div>
          <div>{t('mu.judges.laya.onnx.command')}</div>
          <div className={styles.localJudgeCommand}>
            <code dir='ltr' data-testid='mu-laya-command'>
              {command}
            </code>
            <Button size='mini' onClick={() => void copy()}>
              {t('common.copy')}
            </Button>
          </div>
        </div>
      ) : null}
      <div className={styles.localJudgeActions}>
        {!state.installed && state.support === 'ok' && !onnx ? (
          <Button
            size='small'
            type='primary'
            loading={busy}
            disabled={busy}
            data-testid='mu-laya-install'
            onClick={install}
          >
            {t('mu.judges.laya.install')}
          </Button>
        ) : null}
        {getModel ? (
          <>
            <Button size='small' data-testid='mu-laya-page' onClick={() => void openExternalUrl(LAYA_ONNX_PAGE)}>
              {t('mu.judges.laya.onnx.page')}
            </Button>
            <Button size='small' data-testid='mu-laya-locate' onClick={() => void run('locate')}>
              {t('mu.judges.laya.onnx.openFolder')}
            </Button>
            <Button
              size='small'
              type='primary'
              loading={busy}
              disabled={busy}
              data-testid='mu-laya-check'
              onClick={() => void run('start')}
            >
              {t('mu.judges.laya.onnx.check')}
            </Button>
          </>
        ) : null}
        {!state.installed && state.support === 'uv' ? (
          <Button size='small' data-testid='mu-laya-uv' onClick={() => void openExternalUrl(UV_URL)}>
            {t('mu.judges.laya.uvLink')}
          </Button>
        ) : null}
        {state.installed && !state.running ? (
          <Button
            size='small'
            type='primary'
            loading={busy}
            disabled={busy}
            data-testid='mu-laya-start'
            onClick={() => void run('start')}
          >
            {t('mu.judges.laya.start')}
          </Button>
        ) : null}
        {!guide && (state.running || (onnx && busy && task.action === 'start')) ? (
          <Button
            size='small'
            loading={busy && task.action === 'stop'}
            disabled={busy && task.action === 'stop'}
            data-testid='mu-laya-stop'
            onClick={() => void run('stop')}
          >
            {t('mu.judges.laya.stop')}
          </Button>
        ) : null}
      </div>
      {failed ? (
        <div className={styles.localJudgeProblem} role='alert' data-testid='mu-laya-failed'>
          {failure}
        </div>
      ) : null}
      {(busy || failed) && task.output.length ? (
        <pre className={styles.localJudgeOutput} dir='ltr' data-testid='mu-laya-output'>
          {task.output.slice(busy ? -2 : -6).join('\n')}
        </pre>
      ) : null}
      {problem ? (
        <div className={styles.localJudgeProblem} role='alert'>
          <MuErrorMessage error={problem} />
        </div>
      ) : null}
    </div>
  );
}
