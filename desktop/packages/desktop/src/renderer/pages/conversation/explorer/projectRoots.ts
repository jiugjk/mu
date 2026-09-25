/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Maps the HTTP control-plane `ProjectDetailDto` (roots metadata) into the
 * projection layer's `RootRef[]`. Pure: no I/O, no React — so the display-title
 * fallback and status/role passthrough are unit-testable in isolation. The
 * backend already sorts `entries` by `order_index`; order is preserved here.
 */

import type { ProjectDetailDto, ProjectEntryDto } from '@/common/types/project';

import type { RootRef } from './explorerModel';

/**
 * Human basename of a display path, tolerant of both `/` and `\` separators and
 * trailing slashes (display_path is human-facing, not a protocol path).
 */
const basename = (displayPath: string): string => {
  const trimmed = displayPath.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
};

/**
 * One entry → RootRef. Title precedence: user `display_name` → basename of the
 * `display_path` → `pe_id` (last-resort, never empty). `role` / `runtime_status`
 * pass through onto the root node for pinning + status display.
 */
export const entryToRootRef = (entry: ProjectEntryDto): RootRef => ({
  pe_id: entry.pe_id,
  title: entry.display_name?.trim() || basename(entry.display_path) || entry.pe_id,
  role: entry.role,
  runtimeStatus: entry.runtime_status,
});

/**
 * Full project detail → ordered pe roots for the projection. `workspaceTitle`, when given, names the workspace root
 * instead of its folder: a conversation without a project works in a temporary folder the app made, whose name
 * (`acp-temp-6d952732`) means nothing to the person.
 */
export const toRootRefs = (detail: ProjectDetailDto, workspaceTitle?: string): RootRef[] =>
  detail.explorer.entries.map((entry) => {
    const root = entryToRootRef(entry);
    return workspaceTitle && entry.pe_id === detail.explorer.workspace_pe_id
      ? { ...root, title: workspaceTitle }
      : root;
  });
