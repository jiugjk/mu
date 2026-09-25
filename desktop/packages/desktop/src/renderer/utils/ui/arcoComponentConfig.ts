/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConfigProviderProps } from '@arco-design/web-react';

/**
 * What every Arco component of the app shares. Escape closes a popup (a menu, a popover, a tooltip) while the control
 * that opened it has the focus: Arco leaves it open by default, so a menu opened from the keyboard could be closed
 * only with the mouse. A nested ConfigProvider does not inherit this and must pass it on.
 */
export const ARCO_COMPONENT_CONFIG: ConfigProviderProps['componentConfig'] = {
  Trigger: { escToClose: true },
};
