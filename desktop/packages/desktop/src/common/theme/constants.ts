/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const LIGHT_THEME_ID = 'light';
export const DARK_THEME_ID = 'dark';
/** Sentinel id stored in `theme.activeId`: resolve to Light/Dark from the OS appearance. */
export const SYSTEM_THEME_ID = 'system';

/** The theme in effect follows the OS appearance: 跟随系统 chosen, or no theme chosen yet (the default). */
export const followsSystemTheme = (activeId: string | null | undefined): boolean =>
  !activeId || activeId === SYSTEM_THEME_ID;
