/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssistantListItem } from '../types';
import { resolveAssistantSourceTag } from '../assistantUtils';
import AssistantAvatar, { hasOwnAvatar } from '../AssistantAvatar';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Empty, Switch, Tag } from '@arco-design/web-react';
import { Drag } from '@icon-park/react';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { selectableAssistants } from '@/renderer/utils/model/assistantSelection';

type EnabledAssistantsListProps = {
  assistants: AssistantListItem[];
  assistantOrder: readonly string[];
  localeKey: string;
  searchActive: boolean;
  onOpenDetail: (assistant: AssistantListItem) => void;
  onToggleEnabled: (assistant: AssistantListItem, checked: boolean) => void;
  onReorder: (activeId: string, overId: string) => void | Promise<void>;
  onStartChat: (assistant: AssistantListItem) => void;
};

type EnabledAssistantRowProps = {
  assistant: AssistantListItem;
  localeKey: string;
  /** A list of one has no order to change: no drag handle, and no room kept for one. */
  reorderable: boolean;
  draggable: boolean;
  onOpenDetail: (assistant: AssistantListItem) => void;
  onToggleEnabled: (assistant: AssistantListItem, checked: boolean) => void;
  onStartChat: (assistant: AssistantListItem) => void;
};

const EnabledAssistantRow: React.FC<EnabledAssistantRowProps> = ({
  assistant,
  localeKey,
  reorderable,
  draggable,
  onOpenDetail,
  onToggleEnabled,
  onStartChat,
}) => {
  const { t } = useTranslation();
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: assistant.id,
    disabled: !draggable,
  });
  const name = assistant.name_i18n?.[localeKey] || assistant.name;
  const sourceTag = resolveAssistantSourceTag(assistant.source);
  // An assistant found on this computer needs no tag: only the official and the user's own are told apart.
  const sourceLabel =
    sourceTag === 'builtin'
      ? t('settings.assistantSourceOfficial', { defaultValue: 'Official' })
      : sourceTag === 'cli'
        ? undefined
        : t('settings.assistantSourceCustom', { defaultValue: 'Custom' });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.72 : undefined,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`enabled-assistant-row-${assistant.id}`}
      className='group flex cursor-pointer items-center justify-between gap-12px bg-base px-8px py-12px transition-colors duration-180 hover:bg-fill-1'
      onClick={() => onOpenDetail(assistant)}
    >
      <div className='flex min-w-0 flex-1 items-center gap-12px'>
        {reorderable ? (
          <Button
            ref={setActivatorNodeRef}
            type='text'
            size='small'
            disabled={!draggable}
            aria-label={`${t('settings.assistantReorderHintShort', { defaultValue: 'Drag to reorder' })}: ${name}`}
            data-testid={`enabled-assistant-reorder-handle-${assistant.id}`}
            className={`!min-w-0 !rounded-6px !px-4px !py-0 !text-t-tertiary ${
              draggable ? 'cursor-grab active:cursor-grabbing' : '!opacity-0'
            }`}
            style={{ touchAction: 'none' }}
            onClick={(event) => event.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <Drag size={16} fill='currentColor' />
          </Button>
        ) : null}
        {/* A row names its assistant; a picture only when it has one of its own, never a letter standing in. */}
        {hasOwnAvatar(assistant) ? (
          <AssistantAvatar assistant={assistant} imageFit='contain' shape='circle' size={20} />
        ) : null}
        <div className='flex min-w-0 flex-1 items-center gap-8px'>
          <span className='truncate font-medium text-t-primary'>{name}</span>
          {sourceLabel ? (
            <Tag
              size='small'
              bordered={false}
              className='!shrink-0 !rounded-4px !bg-fill-2 !px-8px !py-1px !text-10px !font-600 !leading-16px !text-t-secondary'
            >
              {sourceLabel}
            </Tag>
          ) : null}
        </div>
      </div>
      <div className='ms-10px flex flex-shrink-0 items-center gap-8px sm:gap-14px' onClick={(e) => e.stopPropagation()}>
        {assistant.enabled !== false ? (
          <Button
            type='text'
            size='small'
            data-testid={`btn-chat-${assistant.id}`}
            className='!inline-flex !h-28px !items-center !justify-center !rounded-6px !bg-fill-2 !px-12px !leading-none !text-t-secondary !opacity-0 transition-all hover:!bg-fill-3 hover:!text-t-primary group-hover:!opacity-100'
            onClick={() => onStartChat(assistant)}
          >
            {t('settings.assistantGoChat', { defaultValue: 'Chat' })}
          </Button>
        ) : null}
        <Switch
          size='small'
          aria-label={name}
          data-testid={`switch-enabled-${assistant.id}`}
          checked={assistant.enabled !== false}
          onChange={(checked) => onToggleEnabled(assistant, checked)}
        />
      </div>
    </div>
  );
};

const EnabledAssistantsList: React.FC<EnabledAssistantsListProps> = ({
  assistants,
  assistantOrder,
  localeKey,
  searchActive,
  onOpenDetail,
  onToggleEnabled,
  onReorder,
  onStartChat,
}) => {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const enabledAssistants = useMemo(
    () => selectableAssistants(assistants, assistantOrder),
    [assistantOrder, assistants]
  );
  const sortingEnabled = !searchActive && enabledAssistants.length > 1;

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const draggedId = String(event.active.id);
      const targetId = event.over ? String(event.over.id) : null;
      if (!sortingEnabled || !targetId || draggedId === targetId) return;
      void onReorder(draggedId, targetId);
    },
    [onReorder, sortingEnabled]
  );

  return (
    <div data-testid='enabled-assistants-list'>
      <p
        data-testid={searchActive ? 'enabled-reorder-search-hint' : 'enabled-reorder-hint'}
        className={`mb-12px mt-0 text-12px leading-relaxed ${searchActive ? 'text-warning-6' : 'text-t-tertiary'}`}
      >
        {searchActive
          ? t('settings.assistantReorderSearchDisabled', { defaultValue: 'Clear search to reorder.' })
          : t('settings.assistantReorderHint', {
              defaultValue: 'Drag to reorder. This decides the display order wherever you pick an assistant.',
            })}
      </p>

      {enabledAssistants.length === 0 ? (
        <div className='settings-list py-28px'>
          <Empty
            description={t('settings.myAssistantsEmpty', {
              defaultValue: 'No assistants here yet. Enable an official assistant, or connect a local CLI tool.',
            })}
          />
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={enabledAssistants.map((assistant) => assistant.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className='settings-list'>
              {enabledAssistants.map((assistant) => (
                <EnabledAssistantRow
                  key={assistant.id}
                  assistant={assistant}
                  localeKey={localeKey}
                  reorderable={enabledAssistants.length > 1}
                  draggable={sortingEnabled}
                  onOpenDetail={onOpenDetail}
                  onToggleEnabled={onToggleEnabled}
                  onStartChat={onStartChat}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
};

export default EnabledAssistantsList;
