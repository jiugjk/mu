import React from 'react';
import { useTranslation } from 'react-i18next';
import { BUILTIN_PERSONALITIES } from '@/common/kyrn/personality';
import ChoiceTile from '@/renderer/pages/settings/KyrnSettings/fields/ChoiceTile';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import styles from './Welcome.module.css';

type PersonalityStepProps = {
  value: string;
  onChange: (id: string) => void;
};

/** The built-in personalities. The one left selected is written when the guide finishes, as a version switch. */
export default function PersonalityStep({ value, onChange }: PersonalityStepProps) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.toLowerCase().startsWith('zh');
  return (
    <>
      <h1 className={styles.title}>{t('mu.welcome.personality.title')}</h1>
      <p className={styles.subtitle}>{t('mu.welcome.personality.subtitle')}</p>
      <div className={choiceStyles.choices} role='radiogroup' aria-label={t('mu.welcome.personality.title')}>
        {BUILTIN_PERSONALITIES.map((personality) => (
          <ChoiceTile
            key={personality.id}
            title={zh ? personality.name.zh : personality.name.en}
            description={zh ? personality.description.zh : personality.description.en}
            active={value === personality.id}
            onPick={() => onChange(personality.id)}
            testId={`mu-welcome-personality-${personality.id}`}
          />
        ))}
      </div>
    </>
  );
}
