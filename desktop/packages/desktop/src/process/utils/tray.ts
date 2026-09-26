/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow, Tray as TrayInstance } from 'electron';
import {
  electronApp as app,
  electronMenu as Menu,
  electronNativeImage as nativeImage,
  electronTray as Tray,
} from '@/common/electronSafe';
import * as path from 'path';
import { ipcBridge } from '@/common';
import { MU_DISPLAY_NAME } from '@/common/kyrn/displayName';
import i18n from '@process/services/i18n';

let tray: TrayInstance | null = null;
let closeToTrayEnabled = false;
let isQuitting = false;
let mainWindowRef: BrowserWindow | null = null;
let cachedActiveCount = 0;

export const setTrayMainWindow = (win: BrowserWindow): void => {
  mainWindowRef = win;
};

export const getCloseToTrayEnabled = (): boolean => closeToTrayEnabled;

export const setCloseToTrayEnabled = (enabled: boolean): void => {
  closeToTrayEnabled = enabled;
};

export const getIsQuitting = (): boolean => isQuitting;

export const setIsQuitting = (quitting: boolean): void => {
  isQuitting = quitting;
};

/**
 * Pure decision helper: when tray icon is activated, should we show or hide?
 * Visible + not minimized → hide; otherwise show/focus.
 * Exported for unit tests.
 */
export const shouldShowFromTray = (isVisible: boolean, isMinimized: boolean): boolean => {
  return !isVisible || isMinimized;
};

const showAndFocusMainWindow = (): void => {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  if (process.platform === 'darwin' && app.dock) {
    void app.dock.show();
  }
  if (mainWindowRef.isMinimized()) {
    mainWindowRef.restore();
  }
  mainWindowRef.show();
  mainWindowRef.focus();
};

const hideMainWindowToTray = (): void => {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  mainWindowRef.hide();
  if (process.platform === 'darwin' && app.dock) {
    void app.dock.hide();
  }
};

/**
 * Toggle main window visibility from the tray icon (show if hidden/minimized, hide if visible).
 */
export const toggleMainWindowFromTray = (): void => {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
  if (shouldShowFromTray(mainWindowRef.isVisible(), mainWindowRef.isMinimized())) {
    showAndFocusMainWindow();
  } else {
    hideMainWindowToTray();
  }
};

/**
 * The menu item that hides the window: a Mac has no tray, its icon sits in the menu bar, so the item says so there.
 * Exported for unit tests.
 */
export const hideItemLabelKey = (platform: NodeJS.Platform): 'common.tray.hideToMenuBar' | 'common.tray.closeToTray' =>
  platform === 'darwin' ? 'common.tray.hideToMenuBar' : 'common.tray.closeToTray';

/** Room for a chat title in the tray menu, in columns: a CJK or emoji character takes two, others one. */
const TRAY_TITLE_MAX_COLUMNS = 32;

const isWideGrapheme = (grapheme: string): boolean => {
  const codePoint = grapheme.codePointAt(0) ?? 0;
  return (
    /\p{Extended_Pictographic}/u.test(grapheme) ||
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
};

/**
 * Shorten a label to `maxColumns` display columns, cutting between graphemes (never inside an emoji or a surrogate
 * pair) and ending with "…". Wide characters count double, so a Chinese title is not twice as wide as an English one.
 * Exported for unit tests.
 */
export const truncateMenuLabel = (text: string, maxColumns = TRAY_TITLE_MAX_COLUMNS, locale?: string): string => {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'grapheme' });
  const graphemes = Array.from(segmenter.segment(text), (part) => part.segment);
  const widths = graphemes.map((grapheme) => (isWideGrapheme(grapheme) ? 2 : 1));
  if (widths.reduce((sum, width) => sum + width, 0) <= maxColumns) return text;
  let used = 0;
  let end = 0;
  // Keep one column for the ellipsis.
  while (end < graphemes.length && used + widths[end] <= maxColumns - 1) {
    used += widths[end];
    end += 1;
  }
  return `${graphemes.slice(0, end).join('').trimEnd()}…`;
};

/**
 * Get tray icon.
 * macOS uses Template image to adapt to dark/light menu bar.
 */
const getTrayIcon = (): Electron.NativeImage => {
  const resourcesPath = app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources');
  const icon = nativeImage.createFromPath(path.join(resourcesPath, 'app.png'));
  if (process.platform === 'darwin') {
    return icon.resize({ width: 16, height: 16 });
  }
  return icon.resize({ width: 32, height: 32 });
};

/**
 * Build tray context menu (async to support dynamic content).
 */
const buildTrayContextMenu = async (): Promise<Electron.Menu> => {
  const getRecentConversations = async (): Promise<Array<{ id: string; title: string }>> => {
    try {
      const result = await ipcBridge.database.getUserConversations.invoke({ limit: 5 });
      return (result.items || []).slice(0, 5).map((conv) => ({
        id: conv.id,
        title: conv.name || i18n.t('common.tray.untitled'),
      }));
    } catch {
      return [];
    }
  };

  const getRunningTasksCount = (): number => cachedActiveCount;

  const recentConversations = await getRecentConversations();
  const runningTasksCount = getRunningTasksCount();

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: i18n.t('common.tray.showWindow'),
      click: showAndFocusMainWindow,
    },
    {
      label: i18n.t(hideItemLabelKey(process.platform)),
      click: hideMainWindowToTray,
    },
    { type: 'separator' },
    {
      label: i18n.t('common.tray.newChat'),
      click: () => {
        showAndFocusMainWindow();
        mainWindowRef?.webContents.send('tray:navigate-to-guid');
      },
    },
  ];

  if (recentConversations.length > 0) {
    template.push({ type: 'separator' });
    template.push({
      label: i18n.t('common.tray.recentChats'),
      enabled: false,
    });
    for (const conv of recentConversations) {
      const displayTitle = truncateMenuLabel(conv.title, TRAY_TITLE_MAX_COLUMNS, i18n.language);
      template.push({
        label: displayTitle,
        click: () => {
          showAndFocusMainWindow();
          mainWindowRef?.webContents.send('tray:navigate-to-conversation', {
            conversation_id: conv.id,
          });
        },
      });
    }
  }

  template.push({ type: 'separator' });
  template.push({
    label: i18n.t('common.trayMenu.runningTasks', { count: runningTasksCount }),
    enabled: false,
  });
  template.push({
    label: i18n.t('common.tray.pauseAll'),
    click: () => {
      showAndFocusMainWindow();
      mainWindowRef?.webContents.send('tray:pause-all-tasks');
    },
  });

  template.push({ type: 'separator' });
  template.push({
    label: i18n.t('common.tray.checkUpdate'),
    click: () => {
      showAndFocusMainWindow();
      // As the menu's "check for updates": the app opens 关于 (About) and checks there.
      ipcBridge.update.open.emit({ source: 'tray' });
    },
  });
  template.push({ type: 'separator' });
  template.push({
    label: i18n.t('common.tray.about'),
    click: () => {
      showAndFocusMainWindow();
      mainWindowRef?.webContents.send('tray:open-about');
    },
  });
  template.push({
    label: i18n.t('common.tray.restart'),
    click: () => {
      isQuitting = true;
      app.relaunch();
      app.exit(0);
    },
  });
  template.push({ type: 'separator' });
  template.push({
    label: i18n.t('common.tray.quit'),
    click: () => {
      isQuitting = true;
      app.quit();
    },
  });

  return Menu.buildFromTemplate(template);
};

/**
 * Create system tray (idempotent — no-op if already exists).
 */
export const createOrUpdateTray = (): void => {
  if (tray) {
    return;
  }
  try {
    const icon = getTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip(MU_DISPLAY_NAME);
    void buildTrayContextMenu().then((menu) => tray?.setContextMenu(menu));

    // Double-click: always show/focus (Windows/Linux; macOS rarely fires this).
    tray.on('double-click', () => {
      showAndFocusMainWindow();
    });

    // Left-click: toggle show/hide on Windows & Linux (Discord/Slack pattern).
    // macOS convention is click → context menu only, so skip toggle there.
    tray.on('click', () => {
      if (process.platform === 'darwin') {
        void buildTrayContextMenu().then((menu) => tray?.setContextMenu(menu));
        return;
      }
      toggleMainWindowFromTray();
    });

    void fetchActiveCountAndMaybeRebuild();
  } catch (err) {
    console.error('[Tray] Failed to create tray:', err);
  }
};

/**
 * Rebuild tray menu with current cached state (synchronous wrapper).
 */
const rebuildTrayMenu = (): void => {
  if (!tray) return;
  void buildTrayContextMenu().then((menu) => tray?.setContextMenu(menu));
};

/**
 * Fetch active count from backend, update cache if changed, and rebuild menu.
 */
const fetchActiveCountAndMaybeRebuild = async (): Promise<void> => {
  try {
    const { count } = await ipcBridge.conversation.activeCount.invoke();
    if (count !== cachedActiveCount) {
      cachedActiveCount = count;
      rebuildTrayMenu();
    }
  } catch {
    // Keep last cached value on error
  }
};

/**
 * Refresh tray context menu labels (called on language change).
 * Immediately rebuilds with current cache, then fetches latest count.
 */
export const refreshTrayMenu = async (): Promise<void> => {
  rebuildTrayMenu();
  await fetchActiveCountAndMaybeRebuild();
};

/**
 * Destroy system tray.
 */
export const destroyTray = (): void => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
};
