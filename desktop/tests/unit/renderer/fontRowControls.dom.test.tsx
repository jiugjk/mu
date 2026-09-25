/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Mirror the project convention: t() echoes the key so aria-labels are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

import FontFamilySelect from '@renderer/components/settings/SettingsModal/contents/AppearanceModalContent/FontFamilySelect';
import FontSizeStepper from '@renderer/components/settings/SettingsModal/contents/AppearanceModalContent/FontSizeStepper';
import FontWeightSelect from '@renderer/components/settings/SettingsModal/contents/AppearanceModalContent/FontWeightSelect';

const DECREASE = 'settings.fontSizeDecrease';
const INCREASE = 'settings.fontSizeIncrease';

const hasClass = (element: Element, name: string) => element.classList.contains(name);

// The appearance page's font rows: in German and Japanese a fixed 170px or 240px cut "Systemstandard" and
// "システムのデフォルト". The selects now take the width of their words; jsdom has no layout, so the classes that
// size them are what is checked here (the widths were measured in a browser).
describe('font selects', () => {
  it('are as wide as their words, from a minimum up to the row, instead of a fixed width', () => {
    render(
      <>
        <FontFamilySelect value='' onChange={vi.fn()} />
        <FontWeightSelect value='' onChange={vi.fn()} />
      </>
    );
    const family = screen.getByRole('combobox', { name: 'settings.fontFamilyLabel' });
    const weight = screen.getByRole('combobox', { name: 'settings.fontWeightLabel' });
    for (const select of [family, weight]) {
      expect(hasClass(select, 'w-max')).toBe(true);
      expect(hasClass(select, 'max-w-full')).toBe(true);
      expect([...select.classList].filter((name) => /^w-\d+px$/.test(name))).toEqual([]);
    }
    expect(hasClass(family, 'min-w-240px')).toBe(true);
    expect(hasClass(weight, 'min-w-170px')).toBe(true);
  });

  it('keep the weight select as wide as its longest name whatever is chosen: every name is there, one is seen', () => {
    render(<FontWeightSelect value='600' onChange={vi.fn()} />);
    const weight = screen.getByRole('combobox', { name: 'settings.fontWeightLabel' });
    const names = [...weight.querySelectorAll('.arco-select-view-value > span > span')];
    expect(names.map((name) => name.textContent)).toEqual([
      'settings.fontWeightSystemDefault',
      'settings.fontWeightLight',
      'settings.fontWeightRegular',
      'settings.fontWeightMedium',
      'settings.fontWeightSemibold',
      'settings.fontWeightBold',
    ]);
    const seen = names.filter((name) => !hasClass(name, 'invisible'));
    expect(seen.map((name) => name.textContent)).toEqual(['settings.fontWeightSemibold']);
    expect(seen[0].getAttribute('aria-hidden')).toBeNull();
    // The hidden names hold the width only: a screen reader does not read them.
    expect(names.filter((name) => name.getAttribute('aria-hidden') === 'true')).toHaveLength(5);
  });
});

describe('FontSizeStepper', () => {
  it('renders the current value and steps within bounds', () => {
    const onChange = vi.fn();
    render(
      <FontSizeStepper value={16} min={12} max={22} step={1} onChange={onChange} resetLabel='Reset' defaultValue={16} />
    );
    expect(screen.getByText('16')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(INCREASE));
    expect(onChange).toHaveBeenCalledWith(17);
    fireEvent.click(screen.getByLabelText(DECREASE));
    expect(onChange).toHaveBeenCalledWith(15);
  });

  it('disables decrease at min and increase at max', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FontSizeStepper value={12} min={12} max={22} step={1} onChange={onChange} resetLabel='Reset' defaultValue={16} />
    );
    expect((screen.getByLabelText(DECREASE) as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <FontSizeStepper value={22} min={12} max={22} step={1} onChange={onChange} resetLabel='Reset' defaultValue={16} />
    );
    expect((screen.getByLabelText(INCREASE) as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets to defaultValue and disables reset when already at default', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FontSizeStepper value={18} min={12} max={22} step={1} onChange={onChange} resetLabel='Reset' defaultValue={16} />
    );
    const reset = screen.getByText('Reset').closest('button') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith(16);

    rerender(
      <FontSizeStepper value={16} min={12} max={22} step={1} onChange={onChange} resetLabel='Reset' defaultValue={16} />
    );
    expect((screen.getByText('Reset').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not fire onChange when clicking disabled bound buttons', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FontSizeStepper value={12} min={12} max={22} step={1} onChange={onChange} resetLabel='Reset' defaultValue={16} />
    );
    fireEvent.click(screen.getByLabelText(DECREASE));
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <FontSizeStepper value={22} min={12} max={22} step={1} onChange={onChange} resetLabel='Reset' defaultValue={16} />
    );
    fireEvent.click(screen.getByLabelText(INCREASE));
    expect(onChange).not.toHaveBeenCalled();
  });
});
