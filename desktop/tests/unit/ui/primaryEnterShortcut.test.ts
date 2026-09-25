/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatPrimaryEnterShortcut } from '@/renderer/utils/ui/keyboardShortcuts';

const onComputer = (userAgent: string): void => {
  vi.stubGlobal('navigator', { userAgent });
};

describe('the save-to-draft shortcut in its tooltip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is the Mac shortcut alone on a Mac', () => {
    onComputer('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');

    expect(formatPrimaryEnterShortcut('Enter')).toBe('⌘ + Enter');
  });

  it('is the Ctrl shortcut alone on Windows and Linux', () => {
    onComputer('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(formatPrimaryEnterShortcut('Enter')).toBe('Ctrl + Enter');

    onComputer('Mozilla/5.0 (X11; Linux x86_64)');
    expect(formatPrimaryEnterShortcut('Enter')).toBe('Ctrl + Enter');
  });

  it('names the Enter key as the app language does', () => {
    onComputer('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');

    expect(formatPrimaryEnterShortcut('Entrée')).toBe('Ctrl + Entrée');
  });
});
