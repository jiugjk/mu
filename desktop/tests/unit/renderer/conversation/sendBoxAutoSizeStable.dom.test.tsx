/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Arco's text area measures its height again whenever its `autoSize` prop changes, and each measurement makes the
 * browser recompute the styles of the whole window. The conversation's send box redraws many times a turn, so an
 * `autoSize` written as a new object in every render measured on every redraw: at 150 turns that was a third of a
 * second of every turn. The send box hands the text area the same object on every render.
 */

import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const { layoutState, autoSizes } = vi.hoisted(() => ({
  layoutState: { isMobile: false },
  autoSizes: [] as unknown[],
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  const TextArea = actual.Input.TextArea;
  const Recording = React.forwardRef<unknown, React.ComponentProps<typeof TextArea>>((props, ref) => {
    autoSizes.push(props.autoSize);
    return <TextArea {...props} ref={ref as never} />;
  });
  return { ...actual, Input: Object.assign(actual.Input, { TextArea: Recording }) };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      listAvailableSkills: { invoke: vi.fn().mockResolvedValue([]) },
      listWorkspaceFiles: { invoke: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({
    conversation_id: 'sendbox-active-focus-conversation',
    type: 'acp',
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: layoutState.isMobile }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: vi.fn(),
    domSnippets: [],
    removeDomSnippet: vi.fn(),
    clearDomSnippets: vi.fn(),
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => [],
}));

vi.mock('@/renderer/hooks/file/useConversationExport', () => ({
  useConversationExport: () => ({
    isOpen: false,
    showMenu: false,
    step: 'menu',
    filename: '',
    pathPreview: '',
    menuItems: [],
    activeIndex: 0,
    loading: false,
    openExportFlow: vi.fn(),
    closeExportFlow: vi.fn(),
    handleKeyDown: vi.fn(),
    onSelectMenuItem: vi.fn(),
    setActiveIndex: vi.fn(),
    setFilename: vi.fn(),
    submitFilename: vi.fn(),
  }),
}));

vi.mock('@/renderer/components/chat/BtwOverlay/useBtwCommand', () => ({
  useBtwCommand: () => ({
    answer: '',
    question: '',
    isLoading: false,
    isOpen: false,
    ask: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@/renderer/hooks/file/useDragUpload', () => ({
  useDragUpload: () => ({ isFileDragging: false, dragHandlers: {} }),
}));

vi.mock('@/renderer/hooks/file/usePasteService', () => ({
  usePasteService: () => ({ onPaste: vi.fn(), onFocus: vi.fn() }),
}));

vi.mock('@/renderer/hooks/file/useUploadState', () => ({
  useUploadState: () => ({ isUploading: false }),
}));

vi.mock('@/renderer/hooks/file/useAbortUploadsOnConversationChange', () => ({
  useAbortUploadsOnConversationChange: vi.fn(),
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: { emit: vi.fn() },
  useAddEventListener: vi.fn(),
}));

vi.mock('@/renderer/components/chat/BtwOverlay', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/UploadProgressBar', () => ({ default: () => null }));

import SendBox from '@/renderer/components/chat/SendBox';

describe('SendBox text area height', () => {
  it('hands the text area the same autoSize object on every render', () => {
    layoutState.isMobile = false;
    const props = { value: '', onChange: vi.fn(), onSend: vi.fn().mockResolvedValue(undefined) };
    const { rerender } = render(<SendBox {...props} defaultMultiLine lockMultiLine loading={false} />);
    // A turn's redraws: the send box is drawn again with the same text.
    rerender(<SendBox {...props} defaultMultiLine lockMultiLine loading />);
    rerender(<SendBox {...props} defaultMultiLine lockMultiLine loading={false} />);

    const objects = autoSizes.filter((value) => typeof value === 'object' && value !== null);
    expect(objects.length).toBeGreaterThanOrEqual(3);
    expect(new Set(objects).size).toBe(1);
    expect(objects[0]).toEqual({ minRows: 1, maxRows: 10 });
  });
});
