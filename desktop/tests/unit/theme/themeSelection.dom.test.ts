import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/common/theme/types';

const { configGetMock, configSetMock, publishMock, windowAppearanceMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configSetMock: vi.fn(),
  publishMock: vi.fn(),
  windowAppearanceMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      setActive: { invoke: publishMock },
      windowAppearance: { invoke: windowAppearanceMock },
    },
  },
}));

vi.mock('@renderer/theme/builtinThemes', () => ({
  BUILTIN_THEMES: [
    { id: 'light', name: 'Light', appearance: 'light', builtin: true, created_at: 0, updated_at: 0 },
    { id: 'dark', name: 'Dark', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0 },
  ] satisfies Theme[],
}));

import { applySystemTheme, setActiveTheme } from '@/renderer/utils/theme/applyTheme';

type BrowserWindow = Window & { electronAPI?: unknown };

const systemIsDark = (dark: boolean) => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: dark,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
};

describe('setActiveTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configGetMock.mockReturnValue([]);
    configSetMock.mockResolvedValue(undefined);
    publishMock.mockResolvedValue(undefined);
    windowAppearanceMock.mockResolvedValue(undefined);
    delete (window as BrowserWindow).electronAPI;
  });

  afterEach(() => {
    (window as BrowserWindow).electronAPI = {};
  });

  it('returns the selected theme in WebUI without invoking the Electron relay', async () => {
    const selected = await setActiveTheme('dark');

    expect(selected.appearance).toBe('dark');
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('publishes the selected theme when running inside Electron', async () => {
    (window as BrowserWindow).electronAPI = {};

    const selected = await setActiveTheme('dark');

    expect(publishMock).toHaveBeenCalledWith(selected);
  });

  it('paints the window in a chosen theme, which does not follow the system', async () => {
    (window as BrowserWindow).electronAPI = {};
    systemIsDark(true);

    await setActiveTheme('light');

    expect(windowAppearanceMock).toHaveBeenCalledWith({ appearance: 'light', followsSystem: false });
  });

  it('tells the window that 跟随系统 follows the system', async () => {
    (window as BrowserWindow).electronAPI = {};
    systemIsDark(true);

    await setActiveTheme('system');

    expect(windowAppearanceMock).toHaveBeenCalledWith({ appearance: 'dark', followsSystem: true });
  });

  it('rejects when the preference cannot be saved', async () => {
    configSetMock.mockRejectedValue(new Error('save failed'));

    await expect(setActiveTheme('dark')).rejects.toThrow('save failed');
    expect(publishMock).not.toHaveBeenCalled();
  });
});

describe('applySystemTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configGetMock.mockReturnValue([]);
    publishMock.mockResolvedValue(undefined);
    windowAppearanceMock.mockResolvedValue(undefined);
    (window as BrowserWindow).electronAPI = {};
  });

  it("applies the system's appearance without saving a choice", async () => {
    systemIsDark(true);

    const applied = await applySystemTheme();

    expect(applied.appearance).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it('paints the window as following the system', async () => {
    systemIsDark(false);

    await applySystemTheme();

    expect(windowAppearanceMock).toHaveBeenCalledWith({ appearance: 'light', followsSystem: true });
  });
});
