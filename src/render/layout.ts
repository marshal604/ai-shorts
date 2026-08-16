import type { FramingMode } from '../types.ts';

/**
 * 直式版面。分四帶：標題、圖表、字幕、平台 UI 保留區。
 * 底部保留區不放任何內容 —— 短影音平台的標題與描述會蓋掉那塊。
 */
export const CANVAS = { width: 1080, height: 1920 } as const;

export const BANDS = {
  title: { y: 60, height: 260 },
  chart: { y: 340, height: 810 },
  subtitle: { y: 1180, height: 270 },
  platformUi: { y: 1450, height: 470 },
} as const;

export const BACKGROUND = '0x0D0D0D';
export const OUTPUT_FPS = 30;
