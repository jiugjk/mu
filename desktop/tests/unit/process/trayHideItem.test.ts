/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { name: 'mu', isPackaged: true, on: vi.fn() },
}));

vi.mock('@/common', () => ({ ipcBridge: {} }));

import i18n, { changeLanguage } from '@/process/services/i18n';
import { hideItemLabelKey } from '@/process/utils/tray';

describe('the tray menu item that hides the window', () => {
  beforeAll(async () => {
    await changeLanguage('en-US');
  });

  afterAll(async () => {
    await changeLanguage('en-US');
  });

  it('names the menu bar on a Mac, where the icon sits', () => {
    expect(i18n.t(hideItemLabelKey('darwin'))).toBe('Hide to Menu Bar');
  });

  it('names the tray on Windows and Linux', () => {
    expect(i18n.t(hideItemLabelKey('win32'))).toBe('Hide to Tray');
    expect(i18n.t(hideItemLabelKey('linux'))).toBe('Hide to Tray');
  });

  it('says menu bar in the app language too', async () => {
    await changeLanguage('zh-CN');

    expect(i18n.t(hideItemLabelKey('darwin'))).toBe('隐藏到菜单栏');
  });
});
