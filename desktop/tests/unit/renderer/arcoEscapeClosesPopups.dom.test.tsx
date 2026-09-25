/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Escape closes an Arco popup while the control that opened it has the focus. Arco leaves popups open on Escape by
 * default, so a menu opened from the keyboard (the composer's model, permission and + menus) stayed open until the
 * mouse clicked elsewhere, and opening a second one left two menus on screen. The app's ConfigProvider turns it on
 * for every popup.
 */

import { ConfigProvider, Dropdown, Menu } from '@arco-design/web-react';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ARCO_COMPONENT_CONFIG } from '@/renderer/utils/ui/arcoComponentConfig';

const ModelMenu = ({ onVisibleChange }: { onVisibleChange: (visible: boolean) => void }) => (
  <Dropdown
    trigger='click'
    popupVisible
    onVisibleChange={onVisibleChange}
    droplist={
      <Menu>
        <Menu.Item key='model'>e2e-fake-model</Menu.Item>
      </Menu>
    }
  >
    <button type='button'>model</button>
  </Dropdown>
);

describe('Escape and Arco popups', () => {
  it('closes an open menu when Escape is pressed on the control that opened it', () => {
    const onVisibleChange = vi.fn();
    render(
      <ConfigProvider componentConfig={ARCO_COMPONENT_CONFIG}>
        <ModelMenu onVisibleChange={onVisibleChange} />
      </ConfigProvider>
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'model' }), { key: 'Escape', keyCode: 27 });

    expect(onVisibleChange).toHaveBeenCalledWith(false);
  });

  it('is what Arco does not do on its own', () => {
    const onVisibleChange = vi.fn();
    render(<ModelMenu onVisibleChange={onVisibleChange} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'model' }), { key: 'Escape', keyCode: 27 });

    expect(onVisibleChange).not.toHaveBeenCalled();
  });
});
