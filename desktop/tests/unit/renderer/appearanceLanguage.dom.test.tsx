import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Appearance page leads with the interface language, the same switch as the first row of System.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@/renderer/services/i18n', () => ({ changeLanguage: vi.fn(() => Promise.resolve()) }));
vi.mock('@renderer/pages/settings/AppearanceSettings/CssThemeSettings', () => ({ default: () => null }));
vi.mock('@/renderer/components/settings/ScaleControl', () => ({ default: () => null }));
vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({
    fontSizes: { app: 14, chat: 14, markdown: 14, code: 13 },
    setFontSize: vi.fn(),
    fontFamilies: {},
    setFontFamily: vi.fn(),
    fontWeights: {},
    setFontWeight: vi.fn(),
  }),
}));
vi.mock('@renderer/components/settings/SettingsModal/contents/AppearanceModalContent/FontFamilySelect', () => ({
  default: () => null,
}));
vi.mock('@renderer/components/settings/SettingsModal/contents/AppearanceModalContent/FontWeightSelect', () => ({
  default: () => null,
}));

import AppearanceModalContent from '@/renderer/components/settings/SettingsModal/contents/AppearanceModalContent';

afterEach(cleanup);

describe('Appearance page', () => {
  it('starts with the interface language', () => {
    render(<AppearanceModalContent />);
    const row = screen.getByTestId('appearance-language');
    expect(within(row).getByText('settings.language')).toBeInTheDocument();
    // The switch shows the language in its own name, and says what it picks.
    expect(within(row).getByText('English')).toBeInTheDocument();
    expect(within(row).getByRole('combobox', { name: 'settings.language' })).toBeInTheDocument();
    // It comes before the theme gallery.
    const theme = screen.getByText('settings.theme');
    expect(row.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
