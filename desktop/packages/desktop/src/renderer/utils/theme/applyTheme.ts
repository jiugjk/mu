/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Theme } from '@/common/theme/types';
import { configService } from '@/common/config/configService';
import { ipcBridge } from '@/common';
import { followsSystemTheme, SYSTEM_THEME_ID } from '@/common/theme/constants';
import { resolveActiveTheme } from '@/common/theme/resolveTheme';
import { BUILTIN_THEMES } from '@renderer/theme/builtinThemes';
import { processCustomCss } from './customCssProcessor';
import { tokensToCss } from './tokensToCss';
import { getSystemPrefersDark } from './systemAppearance';

const TOKENS_STYLE_ID = 'theme-tokens';
const DECORATION_STYLE_ID = 'theme-decoration';

function upsertStyle(id: string, css: string | null, root: Document = document): void {
  const existing = root.getElementById(id);
  if (!css) {
    existing?.remove();
    return;
  }
  const el = (existing as HTMLStyleElement | null) ?? root.createElement('style');
  el.id = id;
  el.textContent = css;
  root.head.appendChild(el); // (re)append to keep it last in <head>
}

function isElectronRenderer(): boolean {
  return typeof window !== 'undefined' && Boolean((window as Window & { electronAPI?: unknown }).electronAPI);
}

/**
 * Publish the theme in effect: the other windows and surfaces take it from the main process's relay, and the window's
 * own background follows it (now, and at the next start, which also needs to know whether it follows the system).
 */
async function publishThemeToElectron(theme: Theme, followsSystem: boolean): Promise<void> {
  if (!isElectronRenderer()) return;
  await ipcBridge.theme.setActive.invoke(theme);
  await ipcBridge.theme.windowAppearance.invoke({ appearance: theme.appearance, followsSystem });
}

/**
 * Write the two appearance attributes as one coupled unit:
 *  - `data-theme` on `<html>` drives our own design tokens
 *  - `arco-theme` on `<body>` drives Arco's color scales and the
 *    `body[arco-theme='dark']` overrides in arco-override.css
 *
 * Both must stay in sync or dark mode splits (our tokens go dark while Arco
 * stays light). `<html>` always exists; `<body>` can be null during early boot
 * (`readyState === 'loading'`). In that case we must NOT silently skip the
 * `arco-theme` write — defer it to DOMContentLoaded so the two attributes still
 * converge once the body is parsed.
 */
function applyAppearanceAttributes(root: Document, appearance: Theme['appearance']): void {
  root.documentElement.setAttribute('data-theme', appearance);
  if (root.body) {
    root.body.setAttribute('arco-theme', appearance);
    return;
  }
  root.addEventListener(
    'DOMContentLoaded',
    () => {
      root.body?.setAttribute('arco-theme', appearance);
    },
    { once: true }
  );
}

/** Apply a resolved theme to a document. Used by every app-chrome surface. */
export function applyTheme(theme: Theme, root: Document = document): void {
  applyAppearanceAttributes(root, theme.appearance);
  upsertStyle(TOKENS_STYLE_ID, tokensToCss(theme.tokens), root);
  upsertStyle(DECORATION_STYLE_ID, theme.css ? processCustomCss(theme.css) : null, root);
}

function resolveWithUserThemes(activeId: string): Theme {
  const userThemes = (configService.get('theme.userThemes') as Theme[] | undefined) ?? [];
  return resolveActiveTheme(activeId, [...BUILTIN_THEMES, ...userThemes], getSystemPrefersDark());
}

/** Resolve `activeId` locally, apply, persist, and publish to Electron for cross-window broadcast. */
export async function setActiveTheme(activeId: string): Promise<Theme> {
  const resolved = resolveWithUserThemes(activeId);
  applyTheme(resolved);
  await configService.set('theme.activeId', activeId);
  await publishThemeToElectron(resolved, followsSystemTheme(activeId));
  return resolved;
}

/**
 * Apply the theme the system's appearance picks now, for a theme that follows it, without saving a choice: a person
 * who never chose one keeps following the system.
 */
export async function applySystemTheme(): Promise<Theme> {
  const resolved = resolveWithUserThemes(SYSTEM_THEME_ID);
  applyTheme(resolved);
  await publishThemeToElectron(resolved, true);
  return resolved;
}

/** Seed Electron's cross-window theme relay. WebUI has no Electron surfaces to notify. */
export async function seedElectronTheme(theme: Theme, followsSystem: boolean): Promise<void> {
  await publishThemeToElectron(theme, followsSystem);
}
