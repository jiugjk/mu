/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Slider } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import { formatNumber } from '@/renderer/services/i18n/format';
import {
  FONT_SCALE_DEFAULT,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
} from '@renderer/hooks/ui/font/useFontScale';

// 浮点数比较容差 / Floating point comparison tolerance
const EPSILON = 0.001;
const RESET_THRESHOLD = 0.01;

/**
 * 将值限制在字体缩放的有效范围内 / Clamp value within valid font scale range
 * @param value - 要限制的值 / Value to clamp
 * @returns 限制后的值 / Clamped value
 */
const clamp = (value: number) => Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));

/** A scale factor as a whole percentage in the app language ("110%", "110 %" in fr-FR, "%110" in tr-TR). */
const formatScalePercent = (value: number, language: string) =>
  formatNumber(value, language, { style: 'percent', maximumFractionDigits: 0 });

/**
 * 缩放控制组件 / Scale control component
 *
 * 提供界面缩放功能，支持滑块和按钮调节
 * Provides interface scaling with slider and button controls
 */
const ScaleControl: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { fontScale, setFontScale, theme } = useThemeContext();

  // 拖动中的临时值，仅用于驱动滑块和百分比显示，松手前不应用缩放
  // Transient value while dragging — drives the slider/label only, scale is applied on release
  const [draggingValue, setDraggingValue] = useState<number | null>(null);

  // 拖动时优先展示临时值，否则展示已应用的缩放 / Prefer the dragging value, fall back to the applied scale
  const displayValue = draggingValue ?? fontScale;

  // 格式化显示值为百分比 / Format display value as percentage
  const formattedValue = useMemo(() => formatScalePercent(displayValue, i18n.language), [displayValue, i18n.language]);

  // Arco draws the slider's handle (role=slider) with no name of its own and takes none from its props: it is given
  // the row's word, so a screen reader says "Scale, slider, 95%" rather than "slider, 0.95".
  const sliderRef = useRef<HTMLDivElement>(null);
  const scaleLabel = t('settings.scale');
  useEffect(() => {
    sliderRef.current?.querySelector('[role="slider"]')?.setAttribute('aria-label', scaleLabel);
  }, [scaleLabel]);

  // 默认标记（100%位置）/ Default mark (100% position)
  const defaultMarks = useMemo(
    () => ({
      1: (
        <span
          className='font-scale-default-mark'
          aria-hidden='true'
          title={formatScalePercent(1, i18n.language)}
        ></span>
      ),
    }),
    [i18n.language]
  );

  /**
   * 拖动过程中只更新临时显示值，不触发缩放 / While dragging, only update the transient value — no scaling
   * @param value - 新的缩放值 / New scale value
   */
  const handleSliderChange = (value: number | number[]) => {
    if (typeof value === 'number') {
      setDraggingValue(clamp(Number(value.toFixed(2))));
    }
  };

  /**
   * 松开滑块时才真正应用缩放 / Apply the scale only when the slider is released
   * @param value - 最终的缩放值 / Final scale value
   */
  const handleSliderAfterChange = (value: number | number[]) => {
    if (typeof value === 'number') {
      void setFontScale(clamp(Number(value.toFixed(2))));
    }
    setDraggingValue(null);
  };

  /**
   * 处理步进调节 / Handle step adjustment
   * @param delta - 步进增量（正数增大，负数减小）/ Step delta (positive to increase, negative to decrease)
   */
  const handleStep = (delta: number) => {
    const next = clamp(Number((fontScale + delta).toFixed(2)));
    void setFontScale(next);
  };

  /**
   * 重置到默认值 / Reset to default value
   */
  const handleReset = () => {
    void setFontScale(FONT_SCALE_DEFAULT);
  };
  const isResetDisabled = Math.abs(fontScale - FONT_SCALE_DEFAULT) < RESET_THRESHOLD;

  return (
    <div className='flex flex-col gap-2 w-full md:max-w-620px'>
      <div className='flex items-center flex-wrap gap-x-12px gap-y-10px w-full'>
        <div className='flex items-center gap-8px flex-1 min-w-240px'>
          <Button
            size='mini'
            type='secondary'
            shape='circle'
            className='w-28px h-28px !min-w-28px flex items-center justify-center p-0'
            onClick={() => handleStep(-FONT_SCALE_STEP)}
            disabled={fontScale <= FONT_SCALE_MIN + EPSILON}
            aria-label={t('common.menu.zoomOut')}
            title={t('common.menu.zoomOut')}
          >
            -
          </Button>
          {/* 滑杆覆盖 80%-150% 区间，随值写入配置 / Slider covers 80%-150% range and persists value */}
          <Slider
            ref={sliderRef}
            className='flex-1 min-w-180px font-scale-slider p-0 m-0'
            showTicks
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            value={displayValue}
            onChange={handleSliderChange}
            onAfterChange={handleSliderAfterChange}
            marks={defaultMarks}
            // The handle's tooltip and its value for a screen reader (aria-valuetext) as the percentage shown beside it.
            formatTooltip={(value) => formatScalePercent(value, i18n.language)}
          />
          <Button
            size='mini'
            type='secondary'
            shape='circle'
            className='w-28px h-28px !min-w-28px flex items-center justify-center p-0'
            onClick={() => handleStep(FONT_SCALE_STEP)}
            disabled={fontScale >= FONT_SCALE_MAX - EPSILON}
            aria-label={t('common.menu.zoomIn')}
            title={t('common.menu.zoomIn')}
          >
            +
          </Button>
        </div>
        <div className='flex items-center gap-10px ms-auto'>
          <span className='text-13px text-t-primary text-end min-w-56px' style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formattedValue}
          </span>
          <Button
            size='small'
            type='text'
            className='px-4px h-28px'
            onClick={handleReset}
            disabled={isResetDisabled}
            style={{
              color: isResetDisabled
                ? theme === 'dark'
                  ? 'rgba(230, 232, 236, 0.62)'
                  : 'rgba(78, 89, 105, 0.72)'
                : 'rgb(var(--primary-6))',
              opacity: 1,
            }}
          >
            {t('settings.scaleReset')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ScaleControl;
