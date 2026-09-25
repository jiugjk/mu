/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Card, Typography } from '@arco-design/web-react';
import { Attention, CheckOne, Forbid, Info } from '@icon-park/react';
import classNames from 'classnames';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import styles from './PermissionRequestPanel.module.css';
import {
  getPermissionOptionsIdentity,
  type PermissionOperationKind,
  type PermissionPanelOption,
} from './permissionOptions';

const { Text } = Typography;

/**
 * Whether an answer failed because nothing waits for it any more, so trying again cannot help: the backend no longer
 * has the question (it was answered elsewhere, or the agent stopped and its questions went with it: "Pending ACP
 * permission not found" or "expired"), or no agent runs for the conversation now (404 "No active agent").
 */
export function isAnswerNoLongerPending(error: unknown): boolean {
  if (!isBackendHttpError(error)) return false;
  const said = error.backendMessage;
  return (
    /pending acp permission (not found|expired)/i.test(said) || (error.status === 404 && /no active agent/i.test(said))
  );
}

type PermissionRequestPanelProps = {
  requestKey: string;
  testIdPrefix: 'message-permission' | 'message-acp-permission';
  title: string;
  description?: string;
  operationKind: PermissionOperationKind;
  detail?: string;
  /** i18n key for the detail block label; defaults to messages.command. Lets a
   *  non-command payload (e.g. a raw tool input dump) carry an accurate label. */
  detailLabelKey?: string;
  options: PermissionPanelOption[];
  onConfirm: (optionValue: string) => Promise<void>;
  /**
   * What was decided, said after the answer went through (e.g. "You said no: rm -rf build"), or undefined to name the
   * answer that was picked.
   */
  decision?: (option: PermissionPanelOption) => string | undefined;
};

/** How an answer reads once given: it let the call run, it refused it, or it chose something else. */
const outcomeOf = (option: PermissionPanelOption): 'allow' | 'deny' | 'other' =>
  option.intent.startsWith('allow') ? 'allow' : option.intent.startsWith('reject') ? 'deny' : 'other';

export const PermissionRequestPanel: React.FC<PermissionRequestPanelProps> = ({
  requestKey,
  testIdPrefix,
  title,
  description,
  operationKind,
  detail,
  detailLabelKey,
  options,
  onConfirm,
  decision,
}) => {
  const { t } = useTranslation();
  const optionsIdentity = getPermissionOptionsIdentity(options);
  const [isResponding, setIsResponding] = useState(false);
  /** The answer that went through; the card then says what it decided. */
  const [answered, setAnswered] = useState<PermissionPanelOption | null>(null);
  const hasResponded = answered !== null;
  const [hasError, setHasError] = useState(false);
  /** The question is gone: its buttons go too. */
  const [isGone, setIsGone] = useState(false);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const respondingRef = useRef(false);
  const requestEpochRef = useRef(0);
  const optionsEpochRef = useRef(0);
  const optionsLabelId = useId();

  useEffect(() => {
    requestEpochRef.current += 1;
    respondingRef.current = false;
    setIsResponding(false);
    setAnswered(null);
    setHasError(false);
    setIsGone(false);
    setSubmittingId(null);
  }, [requestKey]);

  useEffect(() => {
    optionsEpochRef.current += 1;
    setHasError(false);
    setAnswered(null);
    setIsGone(false);
  }, [optionsIdentity]);

  // Every option submits on a single click (allow/reject, once or always,
  // plus neutral) — there is no separate confirm step. The in-flight guard
  // (respondingRef) drops double-clicks and clicks during submission, and the
  // request/option epoch guards ignore results that resolve after the request
  // or the option set has changed underneath us.
  const submitOption = useCallback(
    async (option: PermissionPanelOption) => {
      if (respondingRef.current || hasResponded || isGone || option.disabled) return;

      const requestEpoch = requestEpochRef.current;
      const optionsEpoch = optionsEpochRef.current;
      respondingRef.current = true;
      setIsResponding(true);
      setSubmittingId(option.id);
      setHasError(false);

      try {
        await onConfirm(option.value);
        if (requestEpochRef.current === requestEpoch && optionsEpochRef.current === optionsEpoch) {
          setAnswered(option);
        }
      } catch (error) {
        if (requestEpochRef.current === requestEpoch && optionsEpochRef.current === optionsEpoch) {
          if (isAnswerNoLongerPending(error)) setIsGone(true);
          else setHasError(true);
        }
      } finally {
        if (requestEpochRef.current === requestEpoch) {
          respondingRef.current = false;
          setIsResponding(false);
          setSubmittingId(null);
        }
      }
    },
    [hasResponded, isGone, onConfirm]
  );

  return (
    <Card className={styles.card} bordered={false} data-testid={`${testIdPrefix}-card`}>
      <div className={styles.panel} aria-busy={isResponding}>
        <div className={styles.heading}>
          <div className={styles.titleRow}>
            <Text className={styles.title}>{title}</Text>
            <Text className={styles.operationBadge}>{t(`messages.permissionKind.${operationKind}`)}</Text>
          </div>
          {description && <Text className={styles.description}>{description}</Text>}
        </div>

        {detail && (
          <div className={styles.detailBlock}>
            <Text className={styles.detailLabel}>{t(detailLabelKey || 'messages.command')}</Text>
            <code className={styles.detail} dir='auto'>
              {detail}
            </code>
          </div>
        )}

        {!hasResponded && !isGone && (
          <>
            <fieldset className={styles.optionsFieldset} disabled={isResponding}>
              <legend id={optionsLabelId} className={styles.optionsLegend}>
                {t('messages.chooseAction')}
              </legend>
              {options.length > 0 ? (
                <div
                  className={styles.optionsGroup}
                  role='group'
                  aria-labelledby={optionsLabelId}
                  data-testid={`${testIdPrefix}-options`}
                >
                  {options.map((option) => (
                    <Button
                      key={option.id}
                      className={styles.optionButton}
                      data-testid={option.testId}
                      data-disabled={Boolean(option.disabled || isResponding)}
                      disabled={option.disabled || isResponding}
                      loading={submittingId === option.id}
                      onClick={() => void submitOption(option)}
                    >
                      <span className={styles.optionLabel}>{option.label}</span>
                    </Button>
                  ))}
                </div>
              ) : (
                <Text className={styles.emptyState}>{t('messages.noOptionsAvailable')}</Text>
              )}
            </fieldset>

            {hasError && (
              <div
                className={classNames(styles.feedback, styles.error)}
                role='alert'
                aria-live='assertive'
                data-testid={`${testIdPrefix}-error`}
              >
                <Attention theme='outline' size='16' aria-hidden='true' />
                <span>{t('messages.permissionResponseFailed')}</span>
              </div>
            )}
          </>
        )}

        {isGone && (
          <div className={styles.feedback} role='status' aria-live='polite' data-testid={`${testIdPrefix}-gone`}>
            <Info theme='outline' size='16' aria-hidden='true' />
            <span>{t('messages.permissionNoLongerPending')}</span>
          </div>
        )}

        {answered && (
          // What the answer decided, not only that it was sent: allowed (once, or for longer) or refused.
          <div
            className={classNames(styles.feedback, outcomeOf(answered) === 'allow' && styles.success)}
            role='status'
            aria-live='polite'
            data-testid={`${testIdPrefix}-status`}
            data-outcome={outcomeOf(answered)}
          >
            {outcomeOf(answered) === 'deny' ? (
              <Forbid theme='outline' size='16' aria-hidden='true' />
            ) : (
              <CheckOne theme='outline' size='16' aria-hidden='true' />
            )}
            <span className={styles.decision}>
              {decision?.(answered) ?? t('messages.permissionAnswered', { option: answered.label })}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
};
