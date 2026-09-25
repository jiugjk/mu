import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';

/** How this computer should start mu, as the last step of the guide offers it. */
export type StartupChoice = {
  /** Open mu when the person signs in to this computer. */
  startOnBoot: boolean;
  /** False when this app cannot register a login item (a browser, or Linux). Then `startOnBoot` is not written. */
  bootSupported: boolean;
  /** Closing the window leaves mu in the tray instead of quitting. */
  closeToTray: boolean;
};

export function emptyStartup(): StartupChoice {
  return { startOnBoot: false, bootSupported: false, closeToTray: false };
}

/** What this computer does today. A failure leaves that part at its default rather than blocking the guide. */
export async function loadStartup(): Promise<StartupChoice> {
  const [boot, tray] = await Promise.all([
    ipcBridge.application.getStartOnBootStatus.invoke().catch(() => undefined),
    ipcBridge.systemSettings.getCloseToTray.invoke().catch(() => false),
  ]);
  const status = boot?.success ? boot.data : undefined;
  return {
    startOnBoot: Boolean(status?.enabled),
    bootSupported: Boolean(status?.supported),
    closeToTray: tray === true,
  };
}

/**
 * Applies the choice. Returns which half failed, or undefined. Boot is skipped when this app cannot register a
 * login item, so a browser or Linux does not fail the step the person cannot use.
 */
export async function applyStartup(choice: StartupChoice): Promise<'boot' | 'tray' | undefined> {
  if (choice.bootSupported) {
    const boot = await ipcBridge.application.setStartOnBoot.invoke({ enabled: choice.startOnBoot });
    if (!boot.success) return 'boot';
  }
  try {
    await ipcBridge.systemSettings.setCloseToTray.invoke({ enabled: choice.closeToTray });
    configService.setLocal('system.closeToTray', choice.closeToTray);
  } catch {
    return 'tray';
  }
  return undefined;
}
