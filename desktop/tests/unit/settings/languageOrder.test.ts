/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGES } from '@/common/config/i18n';
import { languageListOrder, nativeLanguageName } from '@/renderer/components/settings/languageOrder';

describe('the language list', () => {
  it('starts with the language in use', () => {
    expect(languageListOrder('ja-JP')[0]).toBe('ja-JP');
    expect(languageListOrder('en-US')[0]).toBe('en-US');
  });

  it('orders the other languages by their own names, so English sits among the Latin ones', () => {
    expect(languageListOrder('zh-CN').map(nativeLanguageName)).toEqual([
      '简体中文',
      'Deutsch',
      'English',
      'Español',
      'Français',
      'Português (BR)',
      'Türkçe',
      'Русский',
      'Українська',
      'فارسی',
      '한국어',
      '日本語',
      '繁體中文',
    ]);
  });

  it('lists every app language once, each under its own name', () => {
    const order = languageListOrder('en-US');

    expect(order.toSorted()).toEqual(SUPPORTED_LANGUAGES.toSorted());
    expect(order.filter((language) => nativeLanguageName(language) === language)).toEqual([]);
  });

  it('reads a bare or unknown code as the language it stands for', () => {
    expect(languageListOrder('zh')[0]).toBe('zh-CN');
    expect(languageListOrder('xx-YY')[0]).toBe('en-US');
  });
});
