import React, { useEffect } from 'react';
import { Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import choiceStyles from '@/renderer/pages/settings/KyrnSettings/sections/sections.module.css';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { loadStartup, type StartupChoice } from './machine';
import styles from './Welcome.module.css';

type StartupStepProps = {
  value: StartupChoice;
  /** False until the computer's current settings have been read. Switches stay off until then. */
  ready: boolean;
  onLoaded: (choice: StartupChoice) => void;
  onChange: (choice: StartupChoice) => void;
};

/**
 * Whether mu opens with the computer, and whether closing the window leaves it in the tray. Both are the same
 * switches as the system settings. In a browser neither can be set, and the step says so.
 */
export default function StartupStep({ value, ready, onLoaded, onChange }: StartupStepProps) {
  const { t } = useTranslation();
  const desktop = isElectronDesktop();

  useEffect(() => {
    if (!desktop) return;
    let live = true;
    void loadStartup().then((choice) => {
      if (live) onLoaded(choice);
    });
    return () => {
      live = false;
    };
  }, [desktop, onLoaded]);

  return (
    <>
      <h1 className={styles.title}>{t('mu.welcome.startup.title')}</h1>
      <p className={styles.subtitle}>{t(desktop ? 'mu.welcome.startup.subtitle' : 'mu.welcome.startup.web')}</p>
      <div className={styles.fields}>
        <div className={styles.switchRow}>
          <span className={styles.switchCopy}>
            <span className={choiceStyles.choiceLabel}>{t('mu.welcome.startup.boot')}</span>
            <span className={choiceStyles.choiceHint}>
              {t(value.bootSupported || !ready ? 'mu.welcome.startup.bootHelp' : 'mu.welcome.startup.bootUnsupported')}
            </span>
          </span>
          <Switch
            aria-label={t('mu.welcome.startup.boot')}
            checked={value.startOnBoot}
            disabled={!desktop || !ready || !value.bootSupported}
            onChange={(startOnBoot) => onChange({ ...value, startOnBoot })}
          />
        </div>
        <div className={styles.switchRow}>
          <span className={styles.switchCopy}>
            <span className={choiceStyles.choiceLabel}>{t('mu.welcome.startup.tray')}</span>
            <span className={choiceStyles.choiceHint}>{t('mu.welcome.startup.trayHelp')}</span>
          </span>
          <Switch
            aria-label={t('mu.welcome.startup.tray')}
            checked={value.closeToTray}
            disabled={!desktop || !ready}
            onChange={(closeToTray) => onChange({ ...value, closeToTray })}
          />
        </div>
      </div>
    </>
  );
}
