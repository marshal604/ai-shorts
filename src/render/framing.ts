import { run, runBinary } from '../exec.ts';
import { ExternalToolError } from '../errors.ts';
import type { Cut } from '../types.ts';
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

/** 夾在畫面內的偶數寬度 —— 超出右緣的裁切框會讓 ffmpeg 直接失敗。 */
function clampWidth(x: number, width: number, sourceWidth: number): number {
  return toEvenSize(Math.min(width, Math.max(2, sourceWidth - x)));
}

/*
 * 曾經有「放大」模式，只取主體右半以看清進場價與停損框。實測四次全部失敗：
 * 圖表右側有一大片留白，K 棒大約在畫面 80% 處就結束，所以「右側 55%」
 * 幾乎都落在空白區，K 棒被留在左邊裁掉。全幅在同一支片裡兩次都完整可讀，
 * 因此整個概念移除 —— 少一個模式，少一整類失敗。
 */

/** 把偵測到的內容分佈換算成實際像素的裁切框。 */
export function planFraming(
  layout: ContentLayout,
  chrome: ChromeInsets,
  sourceWidth: number,
  sourceHeight: number,
  sampleWidth: number,
  sampleHeight: number,
): FramingPlan {
  const scaleX = sourceWidth / sampleWidth;
  const scaleY = sourceHeight / sampleHeight;

  // 介面元件是量出來的，不是假設的 —— 見 detectChrome。
  const bodyLeft = Math.max(layout.body.from, sampleWidth * chrome.left);
  // 垂直方向交給單幀投影 —— 見 detectChrome 的說明。
  const top = layout.vertical.from * scaleY;
  const bottom = layout.vertical.to * scaleY;

  const bodyX = toEvenOffset(bodyLeft * scaleX);
  const height = toEvenSize(Math.min(bottom - top, sourceHeight - toEvenOffset(top)));

  // 沒有偵測到獨立的軸時，一路裁到畫面右緣（扣掉右側的介面元件）。
  //
  // 軸的偵測會隨畫面內容而不穩定（標籤稀疏的幀密度不足）。此時若只裁到
  // 主體右緣，價格軸會整個被切掉 —— 失敗模式應該是「框得不夠緊」，
  // 而不是「丟失價格資訊」。留著死留白也比看不到價位好。
  if (layout.axis === undefined) {
    const rightEdge = sourceWidth * (1 - chrome.right);
    return {
      body: {
        x: bodyX,
        y: toEvenOffset(top),
        width: clampWidth(bodyX, rightEdge - bodyX, sourceWidth),
        height,
      },
    };
  }

  const body: CropBox = {
    x: bodyX,
    y: toEvenOffset(top),
    width: clampWidth(bodyX, layout.body.to * scaleX - bodyX, sourceWidth),
    height,
  };

  const axisX = toEvenOffset(layout.axis.from * scaleX);
  const axisRight = Math.min(sourceWidth, layout.axis.to * scaleX + sourceWidth * AXIS_MARGIN_RATIO);
  return {
    body,
    axis: {
      x: axisX,
      y: body.y,
      width: clampWidth(axisX, axisRight - axisX, sourceWidth),
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
const CHART_RECT_HEIGHT = BANDS.chart.height;

export const CHART_RECT: Placement = {
  scaledWidth: CANVAS.width,
  scaledHeight: CHART_RECT_HEIGHT,
  offsetX: 0,
  offsetY: toEvenOffset(BANDS.chart.y + (BANDS.chart.height - CHART_RECT_HEIGHT) / 2),
};

/**
 * 矩形填滿整個圖表帶，比例 1.33。
 *
 * 曾經是 620 高、比例 1.74，理由是「貼近螢幕錄影裡圖表區的比例（實測約
 * 1.75）」。那個 1.75 是在死留白還被算成內容的時候量的 —— 主體幾乎等於
 * 整幅寬度，量出來當然接近來源的 3258:1826。內容偵測學會排除死留白之後
 * 重新量，K 線區的實際比例是 0.66 到 1.16（六個取樣點），比 1.74 矮胖得多。
 *
 * 繼續用 1.74 的後果不是「切掉一點」：以 1044 寬的裁切去湊 1.74，高度只剩
 * 599，而內容的垂直範圍是 1734 —— 三分之二的價格範圍會被切掉。改成 1.33
 * 之後既貼近實測比例，又順便把圖表帶剩下的 190 像素用掉。
 */
const TARGET_ASPECT = CANVAS.width / CHART_RECT_HEIGHT;

/** 所有片段共用同一個矩形，所以不再需要逐段計算。 */
export function placeInChartBand(): Placement {
  return CHART_RECT;
}

/**
 * 把裁切框調成共用矩形的長寬比。
 *
 * **先蓋住內容，再湊比例。** 舊規則是「保留寬度、調整高度」，那是為了讓
 * 全幅與放大兩種模式靠寬度區分；放大模式移除之後這個理由就消失了，而它
 * 的代價很實際 —— 內容偵測收緊之後裁切變窄，同一條規則會把高度一路砍到
 * 內容垂直範圍的三分之一，價格行為直接被切掉。
 *
 * 現在高度優先：至少要蓋住內容的垂直範圍，再由比例反推寬度。寬度不夠時
 * 往左擴（那裡是更早的 K 棒，比右側的死留白有用），擴到畫面左緣仍不夠，
 * 才回頭壓低高度以維持比例 —— 比例不能妥協，filtergraph 是直接 scale 到
 * 矩形，比例對不上就是把 K 線壓扁。
 *
 * 上緣一律不往回退：內容偵測已經把頂部工具列排除在外。
 */
export function conformToChartAspect(
  framing: FramingPlan,
  sourceWidth: number,
  sourceHeight: number,
  leftBound = 0,
): FramingPlan {
  const axisWidth = framing.axis?.width ?? 0;
  const contentWidth = framing.body.width + axisWidth;
  const contentTop = framing.body.y;
  const centre = contentTop + framing.body.height / 2;

  const availableHeight = sourceHeight - contentTop;
  // 右緣不動 —— 那裡是價格軸與最新的 K 棒；所以能擴的方向只有左邊。
  const bodyRight = framing.body.x + framing.body.width;
  // 但左邊擴到工具列就要停。leftBound 是 detectChrome 量出來的界線；
  // 少了這道夾制，往左擴會把側邊工具列整條吃回畫面裡（實測會多吃 117 像素）。
  const maxTotalWidth = bodyRight - leftBound + axisWidth;

  const wantedHeight = Math.min(
    Math.max(framing.body.height, contentWidth / TARGET_ASPECT),
    availableHeight,
  );
  // 擴不到需要的寬度時，用擴得到的寬度反推高度，比例才不會走樣。
  const totalWidth = Math.min(wantedHeight * TARGET_ASPECT, maxTotalWidth);
  const height = toEvenSize(Math.min(availableHeight, totalWidth / TARGET_ASPECT));
  const bodyWidth = toEvenSize(
    Math.max(2, Math.min(height * TARGET_ASPECT - axisWidth, bodyRight - leftBound)),
  );
  const bodyX = toEvenOffset(Math.max(leftBound, bodyRight - bodyWidth));
  const y = toEvenOffset(
    Math.max(contentTop, Math.min(centre - height / 2, sourceHeight - height)),
  );

  return {
    body: { x: bodyX, y, width: clampWidth(bodyX, bodyWidth, sourceWidth), height },
    ...(framing.axis === undefined ? {} : { axis: { ...framing.axis, y, height } }),
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
  const framing = planFraming(layout, chrome, sourceWidth, sourceHeight, sample.width, sample.height);
  const leftBound = toEvenOffset(chrome.left * sourceWidth);
  return conformToChartAspect(framing, sourceWidth, sourceHeight, leftBound);
}
