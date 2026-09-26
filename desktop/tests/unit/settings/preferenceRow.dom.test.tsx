import React from 'react';
import { render, screen } from '@testing-library/react';
import { Button, Switch } from '@arco-design/web-react';
import { describe, expect, it } from 'vitest';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';

describe('a settings row', () => {
  // QA on macOS, 2026-09-25: the switches of the system page had no name for a screen reader.
  it('names its switch by its title', () => {
    render(
      <PreferenceRow label='Notifications' description='When a reply is ready'>
        <Switch size='small' checked />
      </PreferenceRow>
    );
    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('leaves a button its own words, and a control with a name of its own that name', () => {
    render(
      <>
        <PreferenceRow label='Browser data'>
          <Button size='small'>Clear</Button>
        </PreferenceRow>
        <PreferenceRow label='Start on boot'>
          <Switch aria-label='Open mu at login' />
        </PreferenceRow>
      </>
    );
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Open mu at login' })).toBeInTheDocument();
  });
});
