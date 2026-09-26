/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import {
  ArrowLeft,
  Bee,
  Brain,
  Browser,
  Close,
  Code,
  FolderOpen,
  Gavel,
  PreviewOpen,
  ViewGridDetail,
} from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { WORK_PANEL_TABS, type WorkPanelTab } from './workPanelStore';
import styles from './WorkPanel.module.css';

export const workPanelTabId = (tab: WorkPanelTab): string => `mu-work-panel-tab-${tab}`;
/** 文件 and 源码 share one explorer, so they control the same panel. */
export const workPanelBodyId = (tab: WorkPanelTab): string => `mu-work-panel-body-${tab === 'source' ? 'files' : tab}`;

/** One monochrome icon per tab, drawn instead of the labels when the panel is too narrow for them. */
const TAB_ICONS: Record<WorkPanelTab, typeof Bee> = {
  board: ViewGridDetail,
  judge: Gavel,
  hive: Bee,
  lessons: Brain,
  files: FolderOpen,
  preview: PreviewOpen,
  source: Code,
  browser: Browser,
};

/**
 * Whether every label fits the strip. The labels' width is measured while they show and kept, so the strip goes back
 * to labels as soon as it is wide enough for them again; other labels (another language) are drawn and measured anew.
 */
function useLabelsFit(list: React.RefObject<HTMLDivElement | null>, labels: string, active: WorkPanelTab): boolean {
  const [fit, setFit] = useState(true);
  const shown = useRef(true);
  const needed = useRef(0);
  const check = useCallback(() => {
    const strip = list.current;
    // A closed panel has no width to go by.
    if (!strip?.clientWidth) return;
    if (shown.current) needed.current = strip.scrollWidth;
    const next = needed.current <= strip.clientWidth;
    if (next === shown.current) return;
    shown.current = next;
    setFit(next);
  }, [list]);
  useLayoutEffect(() => {
    shown.current = true;
    setFit(true);
  }, [labels]);
  // The open tab's label is bolder, so a new open tab is measured too.
  useLayoutEffect(() => check(), [check, fit, labels, active]);
  useEffect(() => {
    const strip = list.current;
    if (!strip || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => check());
    observer.observe(strip);
    return () => observer.disconnect();
  }, [check, list]);
  return fit;
}

/**
 * The 40px strip: 看板 · 判定 · 蜂群 · 经验 · 文件 · 预览 · 源码 · 浏览器, then a close button. The open tab is underlined
 * in the one accent colour; a tab with news the person has not seen carries a small dot. Arrow keys move between
 * tabs. A panel too narrow for every label shows one icon per tab instead, each named by its tooltip, so no tab is
 * ever out of view. While the panel fills the row (the transcript set aside), the strip leads with a named way back
 * to the conversation (`onBack`).
 */
export default function WorkPanelTabs({
  active,
  unread,
  onSelect,
  onClose,
  onBack,
}: {
  active: WorkPanelTab;
  unread: ReadonlySet<WorkPanelTab>;
  onSelect: (tab: WorkPanelTab) => void;
  onClose: () => void;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  const labels = WORK_PANEL_TABS.map((tab) => t(`common.workPanel.tabs.${tab}`));
  const labelsFit = useLabelsFit(list, labels.join('\n'), active);
  // Should even the icons not fit (a very large text size), only the strip scrolls: `scrollIntoView` would also shift
  // the clipped panel and the row around it.
  useEffect(() => {
    const strip = list.current;
    const tab = document.getElementById(workPanelTabId(active));
    if (!strip || !tab) return;
    const bounds = strip.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left < bounds.left) strip.scrollLeft -= bounds.left - box.left;
    else if (box.right > bounds.right) strip.scrollLeft += box.right - bounds.right;
  }, [active]);
  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'Home'
        ? -WORK_PANEL_TABS.length
        : event.key === 'End'
          ? WORK_PANEL_TABS.length
          : event.key === 'ArrowRight' || event.key === 'ArrowLeft'
            ? (event.key === 'ArrowRight' ? 1 : -1) *
              (getComputedStyle(event.currentTarget).direction === 'rtl' ? -1 : 1)
            : 0;
    if (!step) return;
    event.preventDefault();
    const index = Math.min(WORK_PANEL_TABS.length - 1, Math.max(0, WORK_PANEL_TABS.indexOf(active) + step));
    const tab = WORK_PANEL_TABS[index];
    onSelect(tab);
    document.getElementById(workPanelTabId(tab))?.focus({ preventScroll: true });
  };
  return (
    <div className={styles.strip}>
      {onBack ? (
        <Button
          type='text'
          size='mini'
          className={styles.back}
          icon={<ArrowLeft size={14} className='rtl-mirror' />}
          onClick={onBack}
          data-testid='work-panel-back'
        >
          {t('common.back')}
        </Button>
      ) : null}
      <div
        ref={list}
        role='tablist'
        aria-label={t('common.workPanel.tabsLabel')}
        className={styles.tabs}
        data-icons={labelsFit ? undefined : 'true'}
        onKeyDown={move}
        onWheel={(event) => {
          if (!event.deltaX) event.currentTarget.scrollLeft += event.deltaY;
        }}
      >
        {WORK_PANEL_TABS.map((tab, index) => {
          const selected = tab === active;
          const label = labels[index];
          const news = unread.has(tab) && !selected;
          const Icon = TAB_ICONS[tab];
          return (
            <Tooltip key={tab} content={label} position='bottom' mini disabled={labelsFit}>
              <Button
                type='text'
                role='tab'
                id={workPanelTabId(tab)}
                aria-selected={selected}
                aria-controls={workPanelBodyId(tab)}
                aria-label={news ? t('common.workPanel.unread', { tab: label }) : labelsFit ? undefined : label}
                tabIndex={selected ? 0 : -1}
                className={styles.tab}
                data-tab={tab}
                onClick={() => onSelect(tab)}
              >
                {labelsFit ? (
                  label
                ) : (
                  <Icon theme='outline' size={16} strokeWidth={3} fill='currentColor' className={styles.tabIcon} />
                )}
                {news ? <span className={styles.dot} data-testid='work-panel-dot' aria-hidden='true' /> : null}
              </Button>
            </Tooltip>
          );
        })}
      </div>
      <Button
        type='text'
        size='mini'
        className={styles.close}
        icon={<Close size={14} />}
        aria-label={t('common.workPanel.close')}
        title={t('common.workPanel.close')}
        onClick={onClose}
      />
    </div>
  );
}
