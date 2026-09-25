import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Arco draws the scale slider's handle with no name and its value as a bare number: a screen reader said
// "slider, 0.95".

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ fontScale: 0.95, setFontScale: vi.fn(), theme: 'light' }),
}));

import ScaleControl from '@/renderer/components/settings/ScaleControl';

afterEach(cleanup);

describe('the scale slider', () => {
  it('is named by the row and reads its value as the percentage shown beside it', () => {
    render(<ScaleControl />);
    const slider = screen.getByRole('slider', { name: 'settings.scale' });
    expect(slider).toHaveAttribute('aria-valuetext', '95%');
  });
});
