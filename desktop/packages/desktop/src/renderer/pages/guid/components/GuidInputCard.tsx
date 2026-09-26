/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import FilePreview from '@/renderer/components/media/FilePreview';
import UploadProgressBar from '@/renderer/components/media/UploadProgressBar';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useCompositionInput } from '@/renderer/hooks/chat/useCompositionInput';
import { Input } from '@arco-design/web-react';
import type { RefTextAreaType } from '@arco-design/web-react/es/Input';
import React, { useEffect, useRef } from 'react';
import styles from '../index.module.css';
import GuidWorkspaceFootnote from './GuidWorkspaceFootnote';

// One object each for every render: the text area measures its height whenever this prop changes.
const DESKTOP_AUTO_SIZE = { minRows: 2, maxRows: 20 };
const MOBILE_AUTO_SIZE = { minRows: 2, maxRows: 8 };

type GuidInputCardProps = {
  focusRequestKey?: string;
  // Input state
  input: string;
  onInputChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: React.ClipboardEventHandler;
  onFocus: () => void;
  onBlur: () => void;
  placeholder: string;

  // Styling
  isInputActive: boolean;
  isFileDragging: boolean;
  dragHandlers: React.HTMLAttributes<HTMLDivElement>;

  // Files
  files: string[];
  onRemoveFile: (path: string) => void;

  // Action row
  actionRow: React.ReactNode;
  slashCommandMenu?: React.ReactNode;

  // Workspace
  workspaceDir: string;
  onSelectWorkspace: (dir: string) => void;
  onClearWorkspace: () => void;
};

const GuidInputCard: React.FC<GuidInputCardProps> = ({
  focusRequestKey,
  input,
  onInputChange,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  placeholder,
  isInputActive,
  isFileDragging,
  dragHandlers,
  files,
  onRemoveFile,
  actionRow,
  slashCommandMenu,
  workspaceDir,
  onSelectWorkspace,
  onClearWorkspace,
}) => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { compositionHandlers, isComposing } = useCompositionInput();
  const inputRef = useRef<RefTextAreaType | null>(null);
  const textareaAutoSize = isMobile ? MOBILE_AUTO_SIZE : DESKTOP_AUTO_SIZE;

  useEffect(() => {
    if (!focusRequestKey || isMobile) return;
    inputRef.current?.focus();
    inputRef.current?.dom.setSelectionRange(input.length, input.length);
  }, [focusRequestKey, input, isMobile]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing.current) return;
    onKeyDown(e);
  };

  return (
    <div
      className={`${styles.guidInputCardWrap} guid-input-card-shell relative rd-24px flex flex-col ${slashCommandMenu ? 'overflow-visible' : 'overflow-hidden'}`}
      data-active={isInputActive && !isFileDragging}
      data-dragging={isFileDragging}
      style={{
        zIndex: 1,
        width: isMobile ? 'calc(100% + 28px)' : undefined,
        marginLeft: isMobile ? -14 : undefined,
        marginRight: isMobile ? -14 : undefined,
      }}
      {...dragHandlers}
    >
      {/* The input, then the project strip below a hairline: one surface, as the send box is. */}
      <div className={`${styles.guidInputInner} relative p-12px flex flex-col`}>
        <Input.TextArea
          ref={inputRef}
          autoSize={textareaAutoSize}
          placeholder={placeholder}
          spellCheck={false}
          className={`text-14px focus:b-none rounded-xl !bg-transparent !b-none !resize-none !py-0 !pe-0 !ps-7px ${styles.lightPlaceholder}`}
          value={input}
          onChange={onInputChange}
          onPaste={onPaste}
          onFocus={onFocus}
          onBlur={onBlur}
          {...compositionHandlers}
          onKeyDown={handleKeyDown}
          data-testid='guid-input'
        />
        <div style={{ height: 12, flexShrink: 0 }} aria-hidden='true' />
        {files.length > 0 && (
          <div className='flex flex-wrap items-center gap-8px mt-12px mb-12px'>
            {files.map((path) => (
              <FilePreview key={path} path={path} onRemove={() => onRemoveFile(path)} />
            ))}
          </div>
        )}
        <UploadProgressBar source='sendbox' />
        {actionRow}
        {slashCommandMenu && <div className='absolute start-0 end-0 top-[calc(100%+4px)] z-70'>{slashCommandMenu}</div>}
      </div>
      <GuidWorkspaceFootnote
        workspaceDir={workspaceDir}
        onSelectWorkspace={onSelectWorkspace}
        onClearWorkspace={onClearWorkspace}
      />
    </div>
  );
};

export default GuidInputCard;
