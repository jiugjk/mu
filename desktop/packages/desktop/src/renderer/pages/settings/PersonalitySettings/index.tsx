import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Input } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { kyrnBridge, unwrap } from '@/common/kyrn/bridge';
import type { PersonalityAction, PersonalityState, PersonalityView } from '@/common/kyrn/personality';
import ChoiceTile from '@/renderer/pages/settings/KyrnSettings/fields/ChoiceTile';
import MuErrorMessage from '@/renderer/pages/settings/KyrnSettings/fields/MuErrorMessage';
import { toMuError } from '@/renderer/pages/settings/KyrnSettings/fields/muError';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import { SettingsPage } from '../components/SettingsPageHeader';

const PROBLEMS = ['unknown', 'id', 'reserved', 'protected', 'empty', 'long', 'name'] as const;

function words(entry: PersonalityView, zh: boolean): { name: string; description: string } {
  return zh
    ? { name: entry.nameZh, description: entry.descriptionZh }
    : { name: entry.nameEn, description: entry.descriptionEn };
}

/**
 * The personality page. A choice writes the same file QQ and `/personality` write, and replaces the
 * personality section of the system prompt rather than appending to it.
 */
const PersonalitySettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.toLowerCase().startsWith('zh');
  const [state, setState] = useState<PersonalityState>();
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [adding, setAdding] = useState(false);
  const [draftId, setDraftId] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    (next: PersonalityState, id = next.active) => {
      setState(next);
      setSelected(id);
      const entry = next.entries.find((item) => item.id === id) ?? next.entries[0];
      if (!entry) return;
      const text = words(entry, zh);
      setName(text.name);
      setDescription(text.description);
      setPrompt(entry.prompt);
    },
    [zh]
  );

  const load = useCallback(() => {
    setError(undefined);
    void kyrnBridge.personality
      .invoke()
      .then(unwrap)
      .then((next) => apply(next))
      .catch((cause: unknown) => setError(cause));
  }, [apply]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (action: PersonalityAction, id = selected): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      apply(unwrap(await kyrnBridge.savePersonality.invoke(action)), action.action === 'remove' ? undefined : id);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const entry = state?.entries.find((item) => item.id === selected);
  const shown = entry ? words(entry, zh) : undefined;
  const problem = error ? toMuError(error) : undefined;
  const problemCode = typeof problem?.params.problem === 'string' ? problem.params.problem : problem?.message;
  const problemText =
    problemCode && (PROBLEMS as readonly string[]).includes(problemCode)
      ? t(`mu.personality.problems.${problemCode}`)
      : undefined;

  return (
    <SettingsPage
      title={t('mu.sections.personality')}
      description={t('mu.personality.description')}
      data-testid='mu-personality'
    >
      {state?.invalid ? <Alert type='warning' content={t('mu.personality.invalid')} /> : null}
      {error ? (
        <Alert
          type='error'
          content={problemText ?? <MuErrorMessage error={error} />}
          action={<Button onClick={load}>{t('mu.reload')}</Button>}
        />
      ) : null}
      {state ? (
        <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.sections.personality')}>
          {state.entries.map((item) => {
            const text = words(item, zh);
            const tag = !item.builtin
              ? t('mu.personality.custom')
              : item.overridden
                ? t('mu.personality.edited')
                : t('mu.personality.builtin');
            return (
              <ChoiceTile
                key={item.id}
                title={text.name}
                tag={tag}
                description={text.description}
                active={item.id === selected}
                testId={`mu-personality-${item.id}`}
                onPick={() => {
                  if (item.id === state.active) {
                    apply(state, item.id);
                    return;
                  }
                  void save({ action: 'use', id: item.id }, item.id);
                }}
              >
                {item.id === selected && shown ? (
                  <div className='flex flex-col gap-12px'>
                    <label className={choiceStyles.choiceLabel}>
                      {t('mu.personality.name')}
                      <Input value={name} maxLength={40} onChange={setName} />
                    </label>
                    <label className={choiceStyles.choiceLabel}>
                      {t('mu.personality.about')}
                      <Input value={description} maxLength={200} onChange={setDescription} />
                    </label>
                    <label className={choiceStyles.choiceLabel}>
                      {t('mu.personality.prompt')}
                      <Input.TextArea
                        value={prompt}
                        autoSize={{ minRows: 6, maxRows: 16 }}
                        onChange={setPrompt}
                        aria-label={t('mu.personality.prompt')}
                      />
                    </label>
                    <p className={choiceStyles.choiceHint}>{t('mu.personality.promptHelp')}</p>
                    <div className='flex gap-8px'>
                      <Button
                        type='primary'
                        loading={busy}
                        onClick={() =>
                          void save({
                            action: 'upsert',
                            id: item.id,
                            name,
                            description,
                            prompt,
                          })
                        }
                      >
                        {t('mu.personality.save')}
                      </Button>
                      {item.builtin && item.overridden ? (
                        <Button loading={busy} onClick={() => void save({ action: 'reset', id: item.id })}>
                          {t('mu.personality.reset')}
                        </Button>
                      ) : null}
                      {!item.builtin ? (
                        <Button
                          status='danger'
                          loading={busy}
                          onClick={() => void save({ action: 'remove', id: item.id })}
                        >
                          {t('mu.personality.remove')}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </ChoiceTile>
            );
          })}
        </div>
      ) : null}
      {adding ? (
        <div className='flex flex-col gap-12px'>
          <Input
            aria-label={t('mu.personality.id')}
            placeholder={t('mu.personality.id')}
            value={draftId}
            onChange={setDraftId}
          />
          <Input
            aria-label={t('mu.personality.name')}
            placeholder={t('mu.personality.name')}
            value={draftName}
            onChange={setDraftName}
          />
          <Input
            aria-label={t('mu.personality.about')}
            placeholder={t('mu.personality.about')}
            value={draftDescription}
            onChange={setDraftDescription}
          />
          <Input.TextArea
            aria-label={t('mu.personality.prompt')}
            placeholder={t('mu.personality.promptHelp')}
            value={draftPrompt}
            autoSize={{ minRows: 4, maxRows: 12 }}
            onChange={setDraftPrompt}
          />
          <div className='flex gap-8px'>
            <Button
              type='primary'
              loading={busy}
              onClick={() => {
                void save({
                  action: 'upsert',
                  id: draftId,
                  name: draftName,
                  description: draftDescription,
                  prompt: draftPrompt,
                }).then((saved) => {
                  if (!saved) return;
                  setAdding(false);
                  setDraftId('');
                  setDraftName('');
                  setDraftDescription('');
                  setDraftPrompt('');
                });
              }}
            >
              {t('mu.personality.create')}
            </Button>
            <Button onClick={() => setAdding(false)}>{t('mu.personality.cancel')}</Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>{t('mu.personality.add')}</Button>
      )}
    </SettingsPage>
  );
};

export default PersonalitySettings;
