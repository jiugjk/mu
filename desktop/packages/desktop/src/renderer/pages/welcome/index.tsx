import React, { useState } from 'react';
import { Alert, AutoComplete, Button, Input, Radio } from '@arco-design/web-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import MuMark from '@renderer/components/brand/MuMark';
import LanguageSwitcher from '@/renderer/components/settings/LanguageSwitcher';
import ChoiceTile from '@/renderer/pages/settings/KyrnSettings/fields/ChoiceTile';
import MuErrorMessage from '@/renderer/pages/settings/KyrnSettings/fields/MuErrorMessage';
import {
  choiceOf,
  choose,
  JUDGE_CHOICES,
  jevKeyVariable,
  profileFor,
} from '@/renderer/pages/settings/KyrnSettings/judgeChoice';
import {
  blankModel,
  blankProvider,
  ENDPOINT_PLACEHOLDER,
  providerLabel,
} from '@/renderer/pages/settings/KyrnSettings/providers/endpoints';
import ConnectionTest from '@/renderer/pages/settings/KyrnSettings/providers/ConnectionTest';
import { ChoiceBody, JudgeChoiceTile } from '@/renderer/pages/settings/KyrnSettings/sections/JudgesSection';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import { useMuSettings } from '@/renderer/pages/settings/KyrnSettings/useMuSettings';
import {
  apiModelProblem,
  type ApiModel,
  type GuideApi,
  markOnboardingSeen,
  withApiModel,
  withSignedInModel,
} from './onboarding';
import SubscriptionLogin from './SubscriptionLogin';
import styles from './Welcome.module.css';

type Step = 'intro' | 'model' | 'judge' | 'done';
/** The steps of the setup itself; the introduction before them is not one. */
const STEPS: Step[] = ['model', 'judge', 'done'];
/** A tile of the model step: an account mu is signed in to, or one of the two API families. */
type Way = 'signedIn' | 'openai' | 'anthropic';
const API_WAYS = ['openai', 'anthropic'] as const;
type ApiWay = (typeof API_WAYS)[number];
type OpenAiApi = Extract<GuideApi, 'openai-completions' | 'openai-responses'>;
const OPENAI_APIS: readonly OpenAiApi[] = ['openai-completions', 'openai-responses'];
const INTRO_POINTS = ['judge', 'control', 'ready'] as const;

/**
 * The first-run guide: what mu is, then connect a model, pick a judge, done. One question at a time, nothing that
 * can wait; all of it is written in one save at the end, and every step can be skipped. Everything here is also in
 * the settings.
 */
export default function Welcome() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const mu = useMuSettings();
  const [step, setStep] = useState<Step>('intro');
  const [way, setWay] = useState<Way>();
  const [openaiApi, setOpenaiApi] = useState<OpenAiApi>('openai-completions');
  const [form, setForm] = useState<Omit<ApiModel, 'api'>>({ baseUrl: '', key: '', model: '' });
  const [signedIn, setSignedIn] = useState('');
  const [listed, setListed] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [added, setAdded] = useState<string>();

  const { base, draft } = mu;
  const chosenWay: Way | undefined = way;

  const leave = () => {
    markOnboardingSeen();
    navigate('/guid', { replace: true });
  };

  const apiOf = (tile: ApiWay): GuideApi => (tile === 'openai' ? openaiApi : 'anthropic-messages');
  const apiInput = (api: GuideApi): ApiModel => ({ api, ...form });
  const problem = chosenWay && chosenWay !== 'signedIn' ? apiModelProblem(apiInput(apiOf(chosenWay))) : undefined;

  const nextFromModel = () => {
    if (!chosenWay) return setStep('judge');
    if (chosenWay === 'signedIn') {
      const [provider, ...rest] = signedIn.split('/');
      const model = rest.join('/');
      setTried(true);
      if (!provider || !model) return;
      mu.edit((now) => withSignedInModel(now, provider, model, added));
      setAdded(undefined);
      setTried(false);
      return setStep('judge');
    }
    setTried(true);
    if (problem || !draft) return;
    const result = withApiModel(draft, apiInput(apiOf(chosenWay)), added);
    mu.edit(() => result.draft);
    setAdded(result.id);
    setStep('judge');
  };

  const finish = async () => {
    if (mu.dirty.size === 0 || (await mu.save())) leave();
  };

  if (!base || !draft) {
    return (
      <div className={styles.screen} data-testid='mu-welcome'>
        <div className={styles.drag} />
        <main className={styles.column}>
          {mu.error ? (
            <Alert
              type='error'
              title={t('mu.load.failed')}
              content={<MuErrorMessage error={mu.error} />}
              action={<Button onClick={mu.reload}>{t('mu.reload')}</Button>}
            />
          ) : (
            <MuMark size={48} halo />
          )}
        </main>
      </div>
    );
  }

  const { settings } = draft;
  const judge = choiceOf(settings);
  const judgeProfile = judge ? settings.judges[profileFor(settings, judge) ?? ''] : undefined;
  const provider = (api: GuideApi) => ({
    ...blankProvider(added ?? 'onboarding'),
    api,
    baseUrl: form.baseUrl.trim(),
    models: [blankModel(form.model.trim())],
  });
  const fieldProblem = (field: 'baseUrl' | 'key' | 'model') =>
    tried && problem === field ? t(`mu.welcome.model.problems.${field}`) : undefined;
  const fieldStatus = (field: 'baseUrl' | 'key' | 'model'): 'error' | undefined =>
    fieldProblem(field) ? 'error' : undefined;

  let body: React.ReactNode;
  if (step === 'intro') {
    body = (
      <>
        <h1 className={styles.heroTitle}>{t('mu.welcome.intro.title')}</h1>
        <p className={styles.lead}>{t('mu.welcome.intro.lead')}</p>
        <ul className={styles.points}>
          {INTRO_POINTS.map((point) => (
            <li key={point} className={styles.point}>
              <span className={styles.pointMark} aria-hidden='true' />
              <div>
                <div className={styles.pointTitle}>{t(`mu.welcome.intro.points.${point}.title`)}</div>
                <div className={styles.pointText}>{t(`mu.welcome.intro.points.${point}.text`)}</div>
              </div>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (step === 'model') {
    body = (
      <>
        <h1 className={styles.title}>{t('mu.welcome.model.title')}</h1>
        <p className={styles.subtitle}>{t('mu.welcome.model.subtitle')}</p>
        <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.welcome.model.title')}>
          <ChoiceTile
            testId='mu-welcome-way-signedIn'
            title={t('mu.welcome.model.signedIn.title')}
            tag={t('mu.welcome.model.signedIn.tag')}
            description={t('mu.welcome.model.signedIn.description')}
            active={chosenWay === 'signedIn'}
            onPick={() => {
              setWay('signedIn');
              setTried(false);
            }}
          >
            <SubscriptionLogin value={signedIn} onChange={setSignedIn} />
            {tried && !signedIn ? (
              <div className={styles.problem} role='alert'>
                {t('mu.welcome.login.needAccount')}
              </div>
            ) : null}
          </ChoiceTile>
          {API_WAYS.map((tile) => {
            const api = apiOf(tile);
            return (
              <ChoiceTile
                key={tile}
                testId={`mu-welcome-way-${tile}`}
                title={t(`mu.welcome.model.${tile}.title`)}
                // The Anthropic tile's description already names Claude: a tag saying it again adds nothing.
                tag={tile === 'openai' ? t('mu.welcome.model.openai.tag') : undefined}
                description={t(`mu.welcome.model.${tile}.description`)}
                active={chosenWay === tile}
                onPick={() => {
                  setWay(tile);
                  setTried(false);
                }}
              >
                <div className={styles.fields}>
                  {tile === 'openai' ? (
                    <Field label={t('mu.welcome.model.openaiApi.label')}>
                      <Radio.Group
                        type='button'
                        aria-label={t('mu.welcome.model.openaiApi.label')}
                        value={openaiApi}
                        onChange={(value: OpenAiApi) => setOpenaiApi(value)}
                        options={OPENAI_APIS.map((value) => ({
                          value,
                          label: t(`mu.welcome.model.openaiApi.${value}`),
                        }))}
                      />
                      <div className={choiceStyles.choiceHint}>{t(`mu.welcome.model.openaiApi.${openaiApi}Hint`)}</div>
                    </Field>
                  ) : null}
                  <Field label={t('mu.welcome.model.baseUrl')} problem={fieldProblem('baseUrl')}>
                    <Input
                      aria-label={t('mu.welcome.model.baseUrl')}
                      status={fieldStatus('baseUrl')}
                      value={form.baseUrl}
                      placeholder={ENDPOINT_PLACEHOLDER[api]}
                      onChange={(baseUrl) => setForm((now) => ({ ...now, baseUrl }))}
                    />
                  </Field>
                  <Field label={t('mu.welcome.model.key')} problem={fieldProblem('key')}>
                    <Input.Password
                      aria-label={t('mu.welcome.model.key')}
                      status={fieldStatus('key')}
                      autoComplete='new-password'
                      value={form.key}
                      placeholder={t('mu.welcome.model.keyPlaceholder')}
                      onChange={(key) => setForm((now) => ({ ...now, key }))}
                    />
                  </Field>
                  <Field label={t('mu.welcome.model.modelId')} problem={fieldProblem('model')}>
                    <AutoComplete
                      aria-label={t('mu.welcome.model.modelId')}
                      status={fieldStatus('model')}
                      value={form.model}
                      data={listed}
                      placeholder={t(`mu.welcome.model.${tile}.modelPlaceholder`)}
                      onChange={(model: string) => setForm((now) => ({ ...now, model }))}
                    />
                  </Field>
                  <ConnectionTest
                    provider={provider(api)}
                    typedKey={form.key.trim()}
                    disabled={apiModelProblem({ ...apiInput(api), model: form.model || 'x' }) === 'baseUrl'}
                    onModels={setListed}
                  />
                </div>
              </ChoiceTile>
            );
          })}
        </div>
      </>
    );
  } else if (step === 'judge') {
    body = (
      <>
        <h1 className={styles.title}>{t('mu.welcome.judge.title')}</h1>
        <p className={styles.subtitle}>{t('mu.welcome.judge.subtitle')}</p>
        <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.welcome.judge.title')}>
          {JUDGE_CHOICES.map((choice) => (
            <JudgeChoiceTile
              key={choice}
              choice={choice}
              active={judge === choice}
              onPick={() => mu.editSettings((now) => choose(now, choice))}
            >
              <ChoiceBody
                choice={choice}
                draft={draft}
                onChange={mu.editSettings}
                onKey={(variable, value) =>
                  mu.edit((now) => ({ ...now, judgeKeys: { ...now.judgeKeys, [variable]: value } }))
                }
              />
            </JudgeChoiceTile>
          ))}
        </div>
      </>
    );
  } else {
    const { provider: startProvider, model } = settings.models.defaults;
    const jevKey = judge === 'jev' ? jevKeyVariable(judgeProfile) : undefined;
    const keyReady = jevKey ? Boolean(settings.keys[jevKey] || draft.judgeKeys[jevKey]) : true;
    body = (
      <>
        <h1 className={styles.title}>{t('mu.welcome.done.title')}</h1>
        <p className={styles.subtitle}>{t('mu.welcome.done.subtitle')}</p>
        <dl className={styles.summary}>
          <div className={styles.summaryRow}>
            <dt>{t('mu.welcome.done.model')}</dt>
            <dd>
              {startProvider && model
                ? t('mu.welcome.done.modelValue', {
                    provider: providerLabel(t, settings.models, startProvider),
                    model,
                  })
                : t('mu.welcome.done.none')}
            </dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>{t('mu.welcome.done.judge')}</dt>
            <dd>
              {judge ? t(`mu.judges.choices.${judge}.title`) : t('mu.welcome.done.none')}
              {judge === 'jev' && !keyReady ? <span className={styles.warn}>{t('mu.welcome.done.noKey')}</span> : null}
            </dd>
          </div>
        </dl>
        {mu.error ? (
          <Alert
            type='error'
            content={
              <MuErrorMessage error={mu.error} frame={(reason) => t('mu.welcome.done.saveFailed', { reason })} />
            }
          />
        ) : null}
      </>
    );
  }

  const index = STEPS.indexOf(step);
  const back = () => setStep(index <= 0 ? 'intro' : STEPS[index - 1]);
  return (
    <div className={styles.screen} data-testid='mu-welcome'>
      <div className={styles.drag} />
      <main className={classNames(styles.column, step === 'intro' && styles.columnIntro)}>
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <MuMark size={step === 'intro' ? 64 : 40} halo />
            {/* Someone on a system in another language can switch before reading a word of the guide. */}
            <div
              className={styles.language}
              role='group'
              aria-label={t('settings.language')}
              data-testid='mu-welcome-language'
            >
              <span>{t('settings.language')}</span>
              <LanguageSwitcher />
            </div>
          </div>
          {step === 'intro' ? null : (
            <ol className={styles.steps} aria-label={t('mu.welcome.progress')}>
              {STEPS.map((name, position) => (
                <li
                  key={name}
                  aria-current={name === step ? 'step' : undefined}
                  className={classNames(styles.stepItem, position <= index && styles.stepReached)}
                >
                  <span className={styles.stepDot} aria-hidden='true' />
                  {t(`mu.welcome.steps.${name}`)}
                </li>
              ))}
            </ol>
          )}
        </header>
        <section key={step} className={styles.body} data-testid={`mu-welcome-step-${step}`}>
          {body}
        </section>
        <footer className={styles.footer}>
          {step === 'intro' ? (
            <button type='button' className={styles.textButton} onClick={leave}>
              {t('mu.welcome.skipAll')}
            </button>
          ) : (
            <button type='button' className={styles.textButton} onClick={back}>
              {t('mu.welcome.back')}
            </button>
          )}
          <span className={styles.spacer} />
          {/* Skipping is a quiet text button on both steps; the lavender button is always the way on. */}
          {step === 'model' || step === 'judge' ? (
            <button
              type='button'
              className={styles.textButton}
              data-testid='mu-welcome-skip'
              onClick={() => setStep(step === 'model' ? 'judge' : 'done')}
            >
              {t('mu.welcome.skipStep')}
            </button>
          ) : null}
          {step === 'intro' ? (
            <Button type='primary' shape='round' data-testid='mu-welcome-begin' onClick={() => setStep('model')}>
              {t('mu.welcome.intro.start')}
            </Button>
          ) : step === 'model' ? (
            <Button type='primary' shape='round' data-testid='mu-welcome-next' onClick={nextFromModel}>
              {t('mu.welcome.next')}
            </Button>
          ) : step === 'judge' ? (
            <Button type='primary' shape='round' data-testid='mu-welcome-next' onClick={() => setStep('done')}>
              {t('mu.welcome.next')}
            </Button>
          ) : (
            <Button
              type='primary'
              shape='round'
              data-testid='mu-welcome-start'
              loading={mu.saving}
              onClick={() => void finish()}
            >
              {t('mu.welcome.start')}
            </Button>
          )}
        </footer>
      </main>
    </div>
  );
}

function Field({ label, problem, children }: { label: string; problem?: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <label className={choiceStyles.choiceLabel}>{label}</label>
      {children}
      {problem ? (
        <div className={styles.problem} role='alert'>
          {problem}
        </div>
      ) : null}
    </div>
  );
}
