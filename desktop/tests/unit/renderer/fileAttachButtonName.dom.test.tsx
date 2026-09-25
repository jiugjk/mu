import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The conversation's "+" was an icon alone: a screen reader said "button" and nothing of what it does.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('swr', () => ({ default: () => ({ data: undefined }) }));
vi.mock('@/common', () => ({ ipcBridge: { fs: { listAvailableSkills: { invoke: vi.fn() } } } }));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({ useConversationContextSafe: () => null }));

import FileAttachButton from '@/renderer/components/media/FileAttachButton';

afterEach(cleanup);

describe('the conversation’s plus button', () => {
  it('says it adds files when it opens the file picker straight away', () => {
    const open = vi.fn();
    render(<FileAttachButton openFileSelector={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'common.fileAttach.addFiles' }));
    expect(open).toHaveBeenCalled();
  });

  it('says it adds when it opens a menu of files, skills and servers', () => {
    render(<FileAttachButton openFileSelector={vi.fn()} loadedSkills={['review']} />);
    expect(screen.getByRole('button', { name: 'common.add' })).toBeInTheDocument();
  });
});
