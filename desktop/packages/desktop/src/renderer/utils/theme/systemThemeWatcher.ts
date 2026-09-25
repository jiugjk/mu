/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { followsSystemTheme } from '@/common/theme/constants';
import type { Theme } from '@/common/theme/types';
import { applySystemTheme } from './applyTheme';
import { watchSystemPrefersDark } from './systemAppearance';

/**
 * While the theme follows the system ("Follow System" chosen, or no theme chosen yet), re-resolve and re-apply it
 * whenever the OS appearance changes, and hand the applied theme to `onApplied`. Nothing is saved: a person who never
 * chose a theme keeps following the system. Returns an unsubscribe function.
 */
export function startSystemThemeWatcher(onApplied?: (theme: Theme) => void): () => void {
  return watchSystemPrefersDark(() => {
    if (!followsSystemTheme(configService.get('theme.activeId') as string | undefined)) return;
    void applySystemTheme()
      .then((theme) => onApplied?.(theme))
      .catch((e) => console.error('re-apply system theme failed', e));
  });
}
