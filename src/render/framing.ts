import { run, runBinary } from '../exec.ts';
import { ExternalToolError } from '../errors.ts';
import type { Cut, FramingMode } from '../types.ts';
import { detectChrome, detectContentLayout } from './crop.ts';
import type { ChromeInsets, ContentLayout } from './crop.ts';
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

/** 偵測介面元件時抽幾張畫面。時間要拉開，才分得出「不會動」與「剛好沒動」。 */
const CHROME_SAMPLES = 3;

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
  chrome: ChromeInsets,
  mode: FramingMode,
  sourceWidth: number,
  sourceHeight: number,
  sampleWidth: number,
  sampleHeight: number,
): FramingPlan {
  const scaleX = sourceWidth / sampleWidth;
  const scaleY = sourceHeight / sampleHeight;

  // 介面元件是量出來的，不是假設的 —— 見 detectChrome。
  const contentLeft = Math.max(layout.body.from, sampleWidth * chrome.left);
  const bodyLeft = contentLeft + (layout.body.to - contentLeft) * BODY_START_RATIO[mode];
  // 垂直方向交給單幀投影 —— 見 detectChrome 的說明。
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

/**
 * 整支短片共用的圖表矩形。
 *
 * 每個片段的裁切框由內容決定，長寬比各不相同；若讓每段各自去適配圖表帶，
 * 圖表的大小與位置會在每次切換片段時跳動 —— 實測同一支片出現 806x810、
 * 1080x598、1080x654 三種矩形，連兩個全幅段彼此都不同。觀眾看到的就是
 * 畫面忽大忽小、上下亂跑。
 *
 * 所以矩形固定，改讓裁切框去遷就它（見 conformToChartAspect）。
 * 全幅與放大的差別因此變成「同樣大小的窗口裡看到多少範圍」，而不是
 * 「窗口本身變形」—— 那才是縮放該有的樣子。
 */
const CHART_RECT_HEIGHT = 620;

export const CHART_RECT: Placement = {
  scaledWidth: CANVAS.width,
  scaledHeight: CHART_RECT_HEIGHT,
  offsetX: 0,
  offsetY: toEvenOffset(BANDS.chart.y + (BANDS.chart.height - CHART_RECT_HEIGHT) / 2),
};

/**
 * 矩形的比例貼近螢幕錄影裡圖表區的比例（實測約 1.75），而不是圖表帶的比例。
 *
 * 兩者差距若太大，湊比例時就得砍掉大量內容：以 4:3 的矩形去套 1.75 的畫面，
 * 全幅模式會被從左邊切掉三分之一，結果與放大模式看起來一模一樣 ——
 * 兩種構圖就此塌陷成同一個視角。
 */
const TARGET_ASPECT = CANVAS.width / CHART_RECT_HEIGHT;

/** 所有片段共用同一個矩形，所以不再需要逐段計算。 */
export function placeInChartBand(): Placement {
  return CHART_RECT;
}

/**
 * 把裁切框調成共用矩形的長寬比。
 *
 * **保留寬度，調整高度。** 寬度就是縮放程度 —— 放大模式取窄、全幅模式取寬，
 * 那是兩者唯一的差別。若改成調整寬度來湊比例，所有片段的高度都一樣，
 * 寬度就會被算成同一個值，兩種模式看起來完全相同。
 *
 * 高度以內容的垂直中心為準往兩側取，價格行為才會留在畫面裡。
 * 只有在需要的高度超出畫面時，才退而收縮寬度。
 */
export function conformToChartAspect(
  framing: FramingPlan,
  sourceWidth: number,
  sourceHeight: number,
): FramingPlan {
  const axisWidth = framing.axis?.width ?? 0;
  const totalWidth = framing.body.width + axisWidth;
  const centre = framing.body.y + framing.body.height / 2;

  const wantedHeight = toEvenSize(totalWidth / TARGET_ASPECT);
  if (wantedHeight <= sourceHeight) {
    const y = toEvenOffset(Math.max(0, Math.min(centre - wantedHeight / 2, sourceHeight - wantedHeight)));
    return {
      body: { ...framing.body, y, height: wantedHeight },
      ...(framing.axis === undefined ? {} : { axis: { ...framing.axis, y, height: wantedHeight } }),
    };
  }

  // 需要的高度超出畫面：改為收縮寬度，右緣不動（那裡是價格軸與最新的 K 棒）。
  const height = toEvenSize(sourceHeight);
  const bodyWidth = toEvenSize(Math.max(2, height * TARGET_ASPECT - axisWidth));
  const bodyRight = framing.body.x + framing.body.width;
  return {
    body: { x: toEvenOffset(Math.max(0, bodyRight - bodyWidth)), y: 0, width: bodyWidth, height },
    ...(framing.axis === undefined ? {} : { axis: { ...framing.axis, y: 0, height } }),
  };
}

/** 影片的實際像素尺寸。計畫要帶著它，渲染時才知道怎麼換算裁切框。 */
export async function probeDimensions(
  video: string,
): Promise<{ readonly width: number; readonly height: number }> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0:s=x',
    video,
  ]);
  const [width, height] = stdout.trim().split('x').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === undefined || height === undefined) {
    throw new ExternalToolError('ffprobe', null, `無法取得影片尺寸：${video}`);
  }
  return { width, height };
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

/**
 * 前置判斷：量出這支影片四邊的介面元件。
 *
 * 一支影片只做一次 —— 介面是整支片的屬性，不會逐片段改變。
 * 抽樣點平均散佈在全片，時間拉得越開，「不會動」的判斷越可靠。
 */
export async function detectVideoChrome(
  video: string,
  durationSeconds: number,
  sourceWidth: number,
  sourceHeight: number,
): Promise<ChromeInsets> {
  const samples = [];
  for (let index = 0; index < CHROME_SAMPLES; index += 1) {
    const at = (durationSeconds * (index + 1)) / (CHROME_SAMPLES + 1);
    samples.push(await sampleFrame(video, at, sourceWidth, sourceHeight));
  }
  const first = samples[0];
  if (first === undefined) return { left: 0, right: 0 };
  return detectChrome(
    samples.map((sample) => sample.gray),
    first.width,
    first.height,
  );
}

/** 算出一個片段的裁切計畫。取片段中點的畫面，段內固定不變。 */
export async function planCutFraming(
  video: string,
  cut: Cut,
  sourceWidth: number,
  sourceHeight: number,
  chrome: ChromeInsets,
): Promise<FramingPlan> {
  const midpoint = cut.start + (cut.end - cut.start) / 2;
  const sample = await sampleFrame(video, midpoint, sourceWidth, sourceHeight);
  const layout = detectContentLayout(sample.gray, sample.width, sample.height);
  const framing = planFraming(
    layout,
    chrome,
    cut.framing,
    sourceWidth,
    sourceHeight,
    sample.width,
    sample.height,
  );
  return conformToChartAspect(framing, sourceWidth, sourceHeight);
}
