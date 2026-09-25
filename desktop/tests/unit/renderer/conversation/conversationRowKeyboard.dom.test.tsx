/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar's conversations work from the keyboard. Before, a row was a plain element with a click handler and its
 * menu (pin, rename, export, archive…) appeared only under the mouse: Tab went from the scheduled-tasks entry straight
 * to the settings button, and a conversation could be renamed or archived only with a mouse. Now Tab reaches each
 * row, Enter or Space opens it, the row's menu button follows it, and the menu it opens takes the focus.
 */

import type { TChatConversation } from '@/common/config/storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: () => ({ info: null }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/pages/conversation/utils/conversationAssistantIdentity', () => ({
  resolveConversationLeadingMark: () => ({ kind: 'default' }),
}));

vi.mock('@/renderer/pages/cron', () => ({
  CronJobIndicator: () => null,
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  useAgentLogos: () => ({}),
}));

vi.mock('@/renderer/utils/ui/siderTooltip', () => ({
  cleanupSiderTooltips: vi.fn(),
  getSiderTooltipProps: () => ({ disabled: true }),
}));

import ConversationRow from '@/renderer/pages/conversation/GroupedHistory/ConversationRow';
import WorkspaceCollapse from '@/renderer/pages/conversation/components/WorkspaceCollapse';
import type { ConversationRowProps } from '@/renderer/pages/conversation/GroupedHistory/types';

const conversation = {
  id: 'keyboard-conversation',
  name: 'Release notes',
  type: 'acp',
  created_at: 1,
  modified_at: 1,
  extra: { backend: 'claude' },
  model: {},
} as TChatConversation;

const makeProps = (overrides: Partial<ConversationRowProps> = {}): ConversationRowProps => ({
  conversation,
  isGenerating: false,
  hasUnread: false,
  isManualUnread: false,
  collapsed: false,
  tooltipEnabled: false,
  batchMode: false,
  checked: false,
  selected: false,
  menuVisible: false,
  onToggleChecked: vi.fn(),
  onConversationClick: vi.fn(),
  onOpenMenu: vi.fn(),
  onMenuVisibleChange: vi.fn(),
  onEditStart: vi.fn(),
  onCreateCronTask: vi.fn(),
  onDelete: vi.fn(),
  onTogglePin: vi.fn(),
  onToggleManualUnread: vi.fn(),
  getJobStatus: () => 'none',
  ...overrides,
});

// The sidebar keeps which row's menu is open, as GroupedHistory does.
function Sidebar({
  onEditStart,
  onConversationClick = vi.fn(),
}: {
  onEditStart: (conversation: TChatConversation) => void;
  onConversationClick?: (conversation: TChatConversation) => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  return (
    <ConversationRow
      {...makeProps({
        menuVisible: menuFor === conversation.id,
        onOpenMenu: (row) => setMenuFor(row.id),
        onMenuVisibleChange: (id, visible) => setMenuFor(visible ? id : null),
        onEditStart,
        onConversationClick,
      })}
    />
  );
}

describe('sidebar conversation rows and the keyboard', () => {
  it('takes the focus and opens the conversation with Enter or Space', () => {
    const onConversationClick = vi.fn();
    render(<ConversationRow {...makeProps({ onConversationClick })} />);

    const row = screen.getByRole('button', { name: 'Release notes' });
    expect(row.tabIndex).toBe(0);

    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(onConversationClick).toHaveBeenCalledTimes(2);
    expect(onConversationClick).toHaveBeenCalledWith(conversation);
  });

  it('checks the row in batch mode instead of opening it', () => {
    const onToggleChecked = vi.fn();
    const onConversationClick = vi.fn();
    render(<ConversationRow {...makeProps({ batchMode: true, onToggleChecked, onConversationClick })} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Release notes' }), { key: 'Enter' });

    expect(onToggleChecked).toHaveBeenCalledWith(conversation);
    expect(onConversationClick).not.toHaveBeenCalled();
  });

  it('has a named menu button that Tab reaches, and a key pressed on it is not the row opening', () => {
    const onConversationClick = vi.fn();
    const onOpenMenu = vi.fn();
    render(<ConversationRow {...makeProps({ onConversationClick, onOpenMenu })} />);

    const menuButton = screen.getByRole('button', { name: 'conversation.history.conversationActions' });
    expect(menuButton.tabIndex).toBe(0);
    expect(menuButton.getAttribute('aria-haspopup')).toBe('menu');
    // Shown while the row has the focus, as it is under the mouse.
    expect(menuButton.className).toContain('group-focus-within:flex');

    fireEvent.keyDown(menuButton, { key: 'Enter' });

    expect(onOpenMenu).toHaveBeenCalledWith(conversation);
    expect(onConversationClick).not.toHaveBeenCalled();
  });

  it('opens the menu on its first item, moves with the arrows and gives the focus back on Escape', async () => {
    const onEditStart = vi.fn();
    render(<Sidebar onEditStart={onEditStart} />);

    const menuButton = screen.getByRole('button', { name: 'conversation.history.conversationActions' });
    act(() => menuButton.focus());
    fireEvent.keyDown(menuButton, { key: 'Enter' });

    const items = await screen.findAllByRole('menuitem');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));
    expect(menuButton.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });

    await waitFor(() => expect(menuButton.getAttribute('aria-expanded')).toBe('false'));
    expect(document.activeElement).toBe(menuButton);
  });

  it('picks the focused item with Enter and does not open the conversation', async () => {
    const onEditStart = vi.fn();
    const onConversationClick = vi.fn();
    render(<Sidebar onEditStart={onEditStart} onConversationClick={onConversationClick} />);

    const menuButton = screen.getByRole('button', { name: 'conversation.history.conversationActions' });
    fireEvent.keyDown(menuButton, { key: 'ArrowDown' });
    const rename = (await screen.findByText('conversation.history.rename')).closest('[role="menuitem"]') as HTMLElement;
    act(() => rename.focus());
    fireEvent.keyDown(rename, { key: 'Enter', keyCode: 13 });

    expect(onEditStart).toHaveBeenCalledWith(conversation);
    expect(onConversationClick).not.toHaveBeenCalled();
  });
});

describe('project headers and the keyboard', () => {
  it('fold and unfold with Enter or Space, and say which they are', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <WorkspaceCollapse expanded={false} onToggle={onToggle} header={<span>project</span>}>
        <div>rows</div>
      </WorkspaceCollapse>
    );

    const header = screen.getByRole('button', { name: 'project' });
    expect(header.tabIndex).toBe(0);
    expect(header.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(header, { key: 'Enter' });
    fireEvent.keyDown(header, { key: ' ' });
    expect(onToggle).toHaveBeenCalledTimes(2);

    rerender(
      <WorkspaceCollapse expanded onToggle={onToggle} header={<span>project</span>}>
        <div>rows</div>
      </WorkspaceCollapse>
    );
    expect(screen.getByRole('button', { name: 'project' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves keys pressed on the buttons at its end to those buttons', () => {
    const onToggle = vi.fn();
    render(
      <WorkspaceCollapse
        expanded
        onToggle={onToggle}
        header={<span>project</span>}
        trailing={
          <span role='button' tabIndex={0} aria-label='new chat in project'>
            +
          </span>
        }
      >
        <div>rows</div>
      </WorkspaceCollapse>
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'new chat in project' }), { key: 'Enter' });

    expect(onToggle).not.toHaveBeenCalled();
  });
});
