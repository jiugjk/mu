import React from 'react';
import { Checkbox, Radio, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  THINKING_LEVELS,
  supportedThinkingLevels,
  withThinkingLevel,
  type ThinkingLevel,
  type ThinkingLevelMap,
} from '@/common/kyrn/models';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import { thinkingLevelLabel } from '@/renderer/utils/model/thinkingLevel';
import styles from './Welcome.module.css';

const UNSET = 'unset';

export type CapabilityValue = {
  imageInput: boolean;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel | '';
  thinkingLevelMap: ThinkingLevelMap;
};

type ModelCapabilitiesProps = {
  value: CapabilityValue;
  onChange: (patch: Partial<CapabilityValue>) => void;
  /**
   * A custom API model: the person says whether it can read images and think, and which levels it takes.
   * A subscription already knows that, so only the level a new conversation starts at is asked.
   */
  capabilities: boolean;
};

/**
 * Image input and thinking, asked with the model. The level checkboxes are what the model offers; the radio is
 * where a new conversation starts, and a conversation can still change that in the send box.
 */
export default function ModelCapabilities({ value, onChange, capabilities }: ModelCapabilitiesProps) {
  const { t } = useTranslation();
  const supported = capabilities
    ? supportedThinkingLevels(value.reasoning, value.thinkingLevelMap)
    : [...THINKING_LEVELS];
  const turnReasoning = (reasoning: boolean) => {
    if (!reasoning) {
      onChange({ reasoning, thinkingLevel: '' });
      return;
    }
    const levels = supportedThinkingLevels(true, value.thinkingLevelMap);
    const kept = value.thinkingLevel && levels.includes(value.thinkingLevel) ? value.thinkingLevel : '';
    onChange({ reasoning, thinkingLevel: kept || (levels.includes('medium') ? 'medium' : '') });
  };
  const setLevel = (level: ThinkingLevel, on: boolean) => {
    const thinkingLevelMap = withThinkingLevel(value.thinkingLevelMap, level, on);
    const levels = supportedThinkingLevels(true, thinkingLevelMap);
    onChange({
      thinkingLevelMap,
      thinkingLevel: value.thinkingLevel && levels.includes(value.thinkingLevel) ? value.thinkingLevel : '',
    });
  };

  return (
    <div className={styles.capabilities}>
      {capabilities ? (
        <>
          <div className={styles.switchRow}>
            <span className={styles.switchCopy}>
              <span className={choiceStyles.choiceLabel}>{t('mu.welcome.model.image')}</span>
              <span className={choiceStyles.choiceHint}>{t('mu.welcome.model.imageHelp')}</span>
            </span>
            <Switch
              aria-label={t('mu.welcome.model.image')}
              checked={value.imageInput}
              onChange={(imageInput) => onChange({ imageInput })}
            />
          </div>
          <div className={styles.switchRow}>
            <span className={styles.switchCopy}>
              <span className={choiceStyles.choiceLabel}>{t('mu.welcome.model.reasoning')}</span>
              <span className={choiceStyles.choiceHint}>{t('mu.welcome.model.reasoningHelp')}</span>
            </span>
            <Switch
              aria-label={t('mu.welcome.model.reasoning')}
              checked={value.reasoning}
              onChange={turnReasoning}
            />
          </div>
          {value.reasoning ? (
            <div className={styles.field}>
              <span className={choiceStyles.choiceLabel}>{t('mu.welcome.model.levels')}</span>
              <div className={styles.levels} data-testid='mu-welcome-levels'>
                {THINKING_LEVELS.map((level) => (
                  <Checkbox
                    key={level}
                    data-testid={`mu-welcome-level-${level}`}
                    checked={supported.includes(level)}
                    onChange={(on) => setLevel(level, on)}
                  >
                    {thinkingLevelLabel(t, level)}
                  </Checkbox>
                ))}
              </div>
              <span className={choiceStyles.choiceHint}>{t('mu.models.levelsHelp')}</span>
            </div>
          ) : null}
        </>
      ) : null}
      <div className={styles.field}>
        <span className={choiceStyles.choiceLabel}>{t('mu.welcome.model.thinkingLevel')}</span>
        <Radio.Group
          type='button'
          size='small'
          className={styles.levelChoice}
          data-testid='mu-welcome-thinking-level'
          aria-label={t('mu.welcome.model.thinkingLevel')}
          disabled={capabilities && !value.reasoning}
          value={capabilities && !value.reasoning ? UNSET : value.thinkingLevel || UNSET}
          onChange={(level: ThinkingLevel | typeof UNSET) => onChange({ thinkingLevel: level === UNSET ? '' : level })}
        >
          <Radio value={UNSET} disabled={capabilities && !value.reasoning}>
            {t('mu.defaults.levelUnset')}
          </Radio>
          {(capabilities ? supported : THINKING_LEVELS).map((level) => (
            <Radio key={level} value={level} disabled={capabilities && !value.reasoning}>
              {thinkingLevelLabel(t, level)}
            </Radio>
          ))}
        </Radio.Group>
        <span className={choiceStyles.choiceHint}>
          {t(capabilities ? 'mu.welcome.model.thinkingLevelHelp' : 'mu.welcome.model.signedInLevelHelp')}
        </span>
      </div>
    </div>
  );
}
