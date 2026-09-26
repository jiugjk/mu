import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Theme } from '@/common/theme/types';

// vi.mock factories are hoisted above const declarations — use vi.hoisted to avoid TDZ errors
const { applySystemTheme, configGet } = vi.hoisted(() => ({
  applySystemTheme: vi.fn(),
  configGet: vi.fn(),
}));

vi.mock('@/renderer/utils/theme/applyTheme', () => ({ applySystemTheme }));
vi.mock('@/common/config/configService', () => ({ configService: { get: configGet } }));

import { startSystemThemeWatcher } from '@renderer/utils/theme/systemThemeWatcher';
import { SYSTEM_THEME_ID } from '@/common/theme/constants';

type ChangeHandler = (e: { matches: boolean }) => void;

const darkTheme: Theme = { id: 'dark', name: 'Dark', appearance: 'dark', builtin: true, created_at: 0, updated_at: 0 };

function installMatchMedia() {
  const handlers = new Set<ChangeHandler>();
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: (_: string, h: ChangeHandler) => handlers.add(h),
    removeEventListener: (_: string, h: ChangeHandler) => handlers.delete(h),
  }) as unknown as typeof window.matchMedia;
  return { fire: (next: boolean) => handlers.forEach((h) => h({ matches: next })) };
}

describe('startSystemThemeWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applySystemTheme.mockResolvedValue(darkTheme);
  });

  it('re-applies the system theme on OS change while system mode is active', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue(SYSTEM_THEME_ID);
    startSystemThemeWatcher();
    media.fire(true);
    expect(applySystemTheme).toHaveBeenCalledTimes(1);
  });

  it('follows the OS while no theme has been chosen yet', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue(undefined);
    startSystemThemeWatcher();
    media.fire(true);
    expect(applySystemTheme).toHaveBeenCalledTimes(1);
  });

  it('hands the applied theme to its caller', async () => {
    const media = installMatchMedia();
    configGet.mockReturnValue(undefined);
    const onApplied = vi.fn();
    startSystemThemeWatcher(onApplied);
    media.fire(true);
    await vi.waitFor(() => expect(onApplied).toHaveBeenCalledWith(darkTheme));
  });

  it('does nothing when a non-system theme is active', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue('misaka-mikoto-theme');
    startSystemThemeWatcher();
    media.fire(true);
    expect(applySystemTheme).not.toHaveBeenCalled();
  });

  it('logs a failed re-apply instead of calling back', async () => {
    const media = installMatchMedia();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    configGet.mockReturnValue(SYSTEM_THEME_ID);
    applySystemTheme.mockRejectedValue(new Error('relay down'));
    const onApplied = vi.fn();
    startSystemThemeWatcher(onApplied);
    media.fire(true);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(onApplied).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('stops re-applying after unsubscribe', () => {
    const media = installMatchMedia();
    configGet.mockReturnValue(SYSTEM_THEME_ID);
    const off = startSystemThemeWatcher();
    off();
    media.fire(true);
    expect(applySystemTheme).not.toHaveBeenCalled();
  });
});
