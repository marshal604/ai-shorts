import { runBinary } from '../exec.ts';
import { ExternalToolError } from '../errors.ts';
import type { Cut, FramingMode } from '../types.ts';
import { detectContentLayout } from './crop.ts';
import type { ContentLayout } from './crop.ts';
import { BANDS, CANVAS } from './layout.ts';

/**
 * 由畫面內容決定每個片段的裁切（ADR-0003）。
 *
 * 裁切框**每個片段只算一次**，片段內固定不動 —— 逐幀重算會讓畫面持續抖動，
 * 在小螢幕上是災難。
 */

/** 偵測用的取樣寬度。縮小取樣只影響邊界精度幾個像素，卻省下大量解碼。 */
const SAMPLE_WIDTH = 640;

/** 裁切右界留的餘裕，否則最下方的價格標籤會貼邊被切。 */
const AXIS_MARGIN_RATIO = 0.004;

/**
 * 左側工具列佔畫面的比例，偵測前先排除。
 *
 * 這個值無法從投影推得：工具列有圖示，在投影上就是「內容」，而且它與
 * 圖表最左緣的 K 線之間沒有空隙，結構上是連續的一段（實測全解析度下
 * 第一個內容區段是 x 6–1213，工具列與 K 線混在一起）。
 *
 * 它是應用程式版面的固定屬性，屬於題材知識，理應放進 Category 的
 * 構圖設定而不是寫在引擎裡。等到第二個類別出現、介面配置真的不同時再搬。
 */
const LEFT_CHROME_RATIO = 0.035;

export interface CropBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FramingPlan {
  /** 主體（K 線）的裁切框。 */
  readonly body: CropBox;
  /** 右側軸的裁切框；有值時要與主體水平併攏，把中間的死留白剪掉。 */
  readonly axis?: CropBox;
}

function toEvenSize(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function toEvenOffset(value: number): number {
  return Math.max(0, Math.round(value / 2) * 2);
}

/**
 * 全幅模式保留左側歷史脈絡，放大模式只取主體的右半 ——
 * 講進場點位時要看的是進場價與停利停損框的細節。
 */
const BODY_START_RATIO: Readonly<Record<FramingMode, number>> = { full: 0, roi: 0.45 };

/** 把偵測到的內容分佈換算成實際像素的裁切框。 */
export function planFraming(
  layout: ContentLayout,
  mode: FramingMode,
  sourceWidth: number,
  sourceHeight: number,
  sampleWidth: number,
  sampleHeight: number,
): FramingPlan {
  const scaleX = sourceWidth / sampleWidth;
  const scaleY = sourceHeight / sampleHeight;

  const chromeEdge = sampleWidth * LEFT_CHROME_RATIO;
  const contentLeft = Math.max(layout.body.from, chromeEdge);
  const bodyLeft = contentLeft + (layout.body.to - contentLeft) * BODY_START_RATIO[mode];
  const top = layout.vertical.from * scaleY;
  const bottom = layout.vertical.to * scaleY;

  const clampWidth = (x: number, width: number) =>
    toEvenSize(Math.min(width, Math.max(2, sourceWidth - x)));

  const bodyX = toEvenOffset(bodyLeft * scaleX);
  const height = toEvenSize(Math.min(bottom - top, sourceHeight - toEvenOffset(top)));

  // 沒有偵測到獨立的軸時，一路裁到畫面右緣。
  //
  // 軸的偵測會隨畫面內容而不穩定（標籤稀疏的幀密度不足）。此時若只裁到
  // 主體右緣，價格軸會整個被切掉 —— 失敗模式應該是「框得不夠緊」，
  // 而不是「丟失價格資訊」。留著死留白也比看不到價位好。
  if (layout.axis === undefined) {
    return {
      body: {
        x: bodyX,
        y: toEvenOffset(top),
        width: clampWidth(bodyX, sourceWidth - bodyX),
        height,
      },
    };
  }

  const body: CropBox = {
    x: bodyX,
    y: toEvenOffset(top),
    width: clampWidth(bodyX, layout.body.to * scaleX - bodyX),
    height,
  };

  const axisX = toEvenOffset(layout.axis.from * scaleX);
  const axisRight = Math.min(sourceWidth, layout.axis.to * scaleX + sourceWidth * AXIS_MARGIN_RATIO);
  return {
    body,
    axis: {
      x: axisX,
      y: body.y,
      width: clampWidth(axisX, axisRight - axisX),
      height: body.height,
    },
  };
}

/** 併攏後送去縮放的整體寬度。 */
export function framingWidth(plan: FramingPlan): number {
  return plan.body.width + (plan.axis?.width ?? 0);
}

export interface Placement {
  readonly scaledWidth: number;
  readonly scaledHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** 等比縮放後置中於圖表帶。 */
export function placeInChartBand(width: number, height: number): Placement {
  const scale = Math.min(CANVAS.width / width, BANDS.chart.height / height);
  const scaledWidth = toEvenSize(width * scale);
  const scaledHeight = toEvenSize(height * scale);
  return {
    scaledWidth,
    scaledHeight,
    offsetX: toEvenOffset((CANVAS.width - scaledWidth) / 2),
    offsetY: toEvenOffset(BANDS.chart.y + (BANDS.chart.height - scaledHeight) / 2),
  };
}

/** 抽一幀灰階像素出來做偵測。取片段中點，避開轉場與剛切換畫面的瞬間。 */
export async function sampleFrame(
  video: string,
  at: number,
  sourceWidth: number,
  sourceHeight: number,
): Promise<{ gray: Uint8Array; width: number; height: number }> {
  const width = SAMPLE_WIDTH;
  const height = Math.round((sourceHeight / sourceWidth) * width / 2) * 2;

  const { stdout } = await runBinary('ffmpeg', [
    '-v', 'error',
    '-ss', at.toFixed(3),
    '-i', video,
    '-frames:v', '1',
    '-vf', `scale=${width}:${height},format=gray`,
    '-pix_fmt', 'gray',
    '-f', 'rawvideo',
    'pipe:1',
  ]);

  const gray = new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length);
  if (gray.length < width * height) {
    throw new ExternalToolError('ffmpeg', null, `抽幀失敗：${video} 第 ${at.toFixed(1)} 秒`);
  }
  return { gray, width, height };
}

/** 算出一個片段的裁切計畫。取片段中點的畫面，段內固定不變。 */
export async function planCutFraming(
  video: string,
  cut: Cut,
  sourceWidth: number,
  sourceHeight: number,
): Promise<FramingPlan> {
  const midpoint = cut.start + (cut.end - cut.start) / 2;
  const sample = await sampleFrame(video, midpoint, sourceWidth, sourceHeight);
  const layout = detectContentLayout(sample.gray, sample.width, sample.height);
  return planFraming(layout, cut.framing, sourceWidth, sourceHeight, sample.width, sample.height);
}
