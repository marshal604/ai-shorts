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

/** 0 到 1 的比例，不是像素 —— 換螢幕或換錄影設定不會壞（ADR-0003）。 */
export interface CropRatio {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ChartPlacement {
  readonly crop: CropRect;
  readonly scaledWidth: number;
  readonly scaledHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * 寫死的裁切比例。`full` 裁掉 TradingView 的工具列後保留左側歷史脈絡，
 * `roi` 放大右側讓進場價與停利停損框看得清楚。
 *
 * 這是暫時的 —— 死留白寬度會隨時間變動（實測 234px 到 491px），
 * 固定矩形本來就不對，內容感知裁切會取代它（ADR-0003）。
 */
export const FIXED_CROPS: Readonly<Record<FramingMode, CropRatio>> = {
  full: { x: 0.035, y: 0.035, width: 0.93, height: 0.92 },
  roi: { x: 0.35, y: 0.08, width: 0.65, height: 0.84 },
};

/** 尺寸必須是偶數且至少 2 —— 零寬高的串流沒有意義。 */
function toEvenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * 位移必須是偶數但**可以是 0**。
 * 若沿用尺寸的下限 2，置中時會算出 `pad` 的輸入區超出畫布右緣，
 * 部分 ffmpeg 版本會直接拒絕整張濾鏡圖。
 */
function toEvenOffset(value: number): number {
  return Math.max(0, Math.round(value / 2) * 2);
}

/** 向下取到偶數，用來把尺寸夾回可用範圍而不會超界。 */
function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * 算出某個構圖模式下，長影片的哪一塊要被裁出來、縮成多大、放在畫布的哪裡。
 * 圖表等比縮放後置中於圖表帶，不裁切也不變形。
 */
export function chartPlacement(
  sourceWidth: number,
  sourceHeight: number,
  mode: FramingMode,
): ChartPlacement {
  const ratio = FIXED_CROPS[mode];

  // 起點與尺寸各自取偶數會讓兩者相加超出來源邊界，所以尺寸要夾回去。
  const cropX = toEvenOffset(sourceWidth * ratio.x);
  const cropY = toEvenOffset(sourceHeight * ratio.y);
  const crop: CropRect = {
    x: cropX,
    y: cropY,
    width: Math.min(toEvenSize(sourceWidth * ratio.width), evenFloor(sourceWidth - cropX)),
    height: Math.min(toEvenSize(sourceHeight * ratio.height), evenFloor(sourceHeight - cropY)),
  };

  const scale = Math.min(CANVAS.width / crop.width, BANDS.chart.height / crop.height);
  const scaledWidth = toEvenSize(crop.width * scale);
  const scaledHeight = toEvenSize(crop.height * scale);

  return {
    crop,
    scaledWidth,
    scaledHeight,
    offsetX: toEvenOffset((CANVAS.width - scaledWidth) / 2),
    offsetY: toEvenOffset(BANDS.chart.y + (BANDS.chart.height - scaledHeight) / 2),
  };
}
