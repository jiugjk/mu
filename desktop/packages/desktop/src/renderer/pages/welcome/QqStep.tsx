import React from 'react';
import { Input, InputNumber, Radio, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  QQ_DM_POLICIES,
  QQ_GROUP_POLICIES,
  type QqDmPolicy,
  type QqGatewayInput,
  type QqGatewayProblem,
  type QqGroupPolicy,
  type QqTransport,
} from '@/common/kyrn/qqGateway';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import styles from './Welcome.module.css';

type QqStepProps = {
  value: QqGatewayInput;
  problem?: QqGatewayProblem;
  tried: boolean;
  onChange: (patch: Partial<QqGatewayInput>) => void;
};

/**
 * The QQ bot gateway: AppID and AppSecret, how messages arrive, and who may talk to it. Left off, nothing is
 * written. Starting the gateway itself is still `mu qqbot start`.
 */
export default function QqStep({ value, problem, tried, onChange }: QqStepProps) {
  const { t } = useTranslation();
  const fieldProblem = (field: QqGatewayProblem) =>
    tried && problem === field ? t(`mu.welcome.qq.problems.${field}`) : undefined;

  return (
    <>
      <h1 className={styles.title}>{t('mu.welcome.qq.title')}</h1>
      <p className={styles.subtitle}>{t('mu.welcome.qq.subtitle')}</p>
      <div className={styles.fields}>
        <div className={styles.switchRow}>
          <span className={styles.switchCopy}>
            <span className={choiceStyles.choiceLabel}>{t('mu.welcome.qq.enable')}</span>
            <span className={choiceStyles.choiceHint}>{t('mu.welcome.qq.enableHelp')}</span>
          </span>
          <Switch
            aria-label={t('mu.welcome.qq.enable')}
            checked={value.enabled}
            onChange={(enabled) => onChange({ enabled })}
          />
        </div>
        {value.enabled ? (
          <>
            <Field label={t('mu.welcome.qq.appId')} problem={fieldProblem('appId')}>
              <Input
                aria-label={t('mu.welcome.qq.appId')}
                status={fieldProblem('appId') ? 'error' : undefined}
                value={value.appId}
                placeholder='102000000'
                onChange={(appId) => onChange({ appId })}
              />
            </Field>
            <Field label={t('mu.welcome.qq.secret')} problem={fieldProblem('secret')}>
              <Input.Password
                aria-label={t('mu.welcome.qq.secret')}
                status={fieldProblem('secret') ? 'error' : undefined}
                autoComplete='new-password'
                value={value.clientSecret}
                placeholder={t('mu.welcome.qq.secretPlaceholder')}
                onChange={(clientSecret) => onChange({ clientSecret })}
              />
            </Field>
            <Field label={t('mu.welcome.qq.transport')}>
              <Radio.Group
                type='button'
                aria-label={t('mu.welcome.qq.transport')}
                value={value.transport}
                onChange={(transport: QqTransport) => onChange({ transport })}
                options={(
                  [
                    ['websocket', t('mu.welcome.qq.websocket')],
                    ['webhook', t('mu.welcome.qq.webhook')],
                  ] as const
                ).map(([entry, label]) => ({ value: entry, label }))}
              />
            </Field>
            {value.transport === 'webhook' ? (
              <>
                <Field label={t('mu.welcome.qq.port')} problem={fieldProblem('port')}>
                  <InputNumber
                    aria-label={t('mu.welcome.qq.port')}
                    min={1}
                    max={65535}
                    precision={0}
                    value={value.webhookPort}
                    onChange={(port) => typeof port === 'number' && onChange({ webhookPort: port })}
                  />
                </Field>
                <Field label={t('mu.welcome.qq.path')} problem={fieldProblem('path')}>
                  <Input
                    aria-label={t('mu.welcome.qq.path')}
                    status={fieldProblem('path') ? 'error' : undefined}
                    value={value.webhookPath}
                    onChange={(webhookPath) => onChange({ webhookPath })}
                  />
                </Field>
              </>
            ) : null}
            <Field label={t('mu.welcome.qq.dmPolicy')} hint={t('mu.welcome.qq.dmHelp')}>
              <Radio.Group
                type='button'
                className={styles.levelChoice}
                aria-label={t('mu.welcome.qq.dmPolicy')}
                value={value.dmPolicy}
                onChange={(dmPolicy: QqDmPolicy) => onChange({ dmPolicy })}
                options={QQ_DM_POLICIES.map((entry) => ({ value: entry, label: t(`mu.welcome.qq.dm.${entry}`) }))}
              />
            </Field>
            <Field label={t('mu.welcome.qq.groupPolicy')} hint={t('mu.welcome.qq.groupHelp')}>
              <Radio.Group
                type='button'
                className={styles.levelChoice}
                aria-label={t('mu.welcome.qq.groupPolicy')}
                value={value.groupPolicy}
                onChange={(groupPolicy: QqGroupPolicy) => onChange({ groupPolicy })}
                options={QQ_GROUP_POLICIES.map((entry) => ({
                  value: entry,
                  label: t(`mu.welcome.qq.group.${entry}`),
                }))}
              />
            </Field>
            <div className={styles.switchRow}>
              <span className={choiceStyles.choiceLabel}>{t('mu.welcome.qq.markdown')}</span>
              <Switch
                aria-label={t('mu.welcome.qq.markdown')}
                checked={value.markdownSupport}
                onChange={(markdownSupport) => onChange({ markdownSupport })}
              />
            </div>
            <div className={styles.switchRow}>
              <span className={styles.switchCopy}>
                <span className={choiceStyles.choiceLabel}>{t('mu.welcome.qq.mention')}</span>
                <span className={choiceStyles.choiceHint}>{t('mu.welcome.qq.mentionHelp')}</span>
              </span>
              <Switch
                aria-label={t('mu.welcome.qq.mention')}
                checked={value.defaultRequireMention}
                onChange={(defaultRequireMention) => onChange({ defaultRequireMention })}
              />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

function Field({
  label,
  problem,
  hint,
  children,
}: {
  label: string;
  problem?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={choiceStyles.choiceLabel}>{label}</label>
      {children}
      {hint ? <span className={choiceStyles.choiceHint}>{hint}</span> : null}
      {problem ? (
        <div className={styles.problem} role='alert'>
          {problem}
        </div>
      ) : null}
    </div>
  );
}
