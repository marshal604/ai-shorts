/**
 * 內容感知裁切（ADR-0003）。
 *
 * 對灰階原始幀做逐欄與逐列投影，找出畫面上哪些區域真的有內容。
 * 固定矩形不可行：實測同一支影片的圖表右側留白在兩幀之間從 234 像素
 * 變成 491 像素，固定矩形要嘛切掉價格軸、要嘛留下大片死白。
 */

export interface Range {
  readonly from: number;
  readonly to: number;
}

export interface ContentLayout {
  /** 主要內容（K 線）的範圍。 */
  readonly body: Range;
  /** 右側的軸標籤區塊；沒有偵測到就是 undefined。 */
  readonly axis?: Range;
  /** 垂直方向的內容範圍，已排除上下的工具列與座標軸。 */
  readonly vertical: Range;
}

export interface DetectOptions {
  /** 偏離背景色多少才算內容。 */
  readonly threshold?: number;
  /** 一欄有多少比例的像素算內容，該欄才算有內容。 */
  readonly density?: number;
  /** 連續多少像素才算一個區塊，用來濾掉細線與雜訊。 */
  readonly minRun?: number;
}

const DEFAULTS = { threshold: 14, density: 0.012, minRun: 26 } as const;

/** 全幀眾數即背景色 —— 螢幕錄影的背景佔絕大多數像素。 */
export function backgroundLevel(gray: Uint8Array): number {
  const histogram = new Uint32Array(256);
  // 每七個像素取樣一次：眾數不需要全掃，但要避開規律的取樣週期。
  for (let index = 0; index < gray.length; index += 7) {
    const level = gray[index] ?? 0;
    histogram[level] = (histogram[level] ?? 0) + 1;
  }
  let best = 0;
  for (let level = 1; level < 256; level += 1) {
    if ((histogram[level] ?? 0) > (histogram[best] ?? 0)) best = level;
  }
  return best;
}

interface Projections {
  readonly columns: Float32Array;
  readonly rows: Float32Array;
}

function project(gray: Uint8Array, width: number, height: number, threshold: number): Projections {
  const columns = new Float32Array(width);
  const rows = new Float32Array(height);
  const background = backgroundLevel(gray);

  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (Math.abs((gray[offset + x] ?? background) - background) > threshold) {
        columns[x] = (columns[x] ?? 0) + 1;
        rows[y] = (rows[y] ?? 0) + 1;
      }
    }
  }

  for (let x = 0; x < width; x += 1) columns[x] = (columns[x] ?? 0) / height;
  for (let y = 0; y < height; y += 1) rows[y] = (rows[y] ?? 0) / width;
  return { columns, rows };
}

/** 把「密度超過門檻」的連續區段找出來，短於 minRun 的視為雜訊。 */
export function runsAbove(
  values: Float32Array | readonly number[],
  density: number,
  minRun: number,
): Range[] {
  const runs: Range[] = [];
  let start = -1;

  for (let index = 0; index < values.length; index += 1) {
    const above = (values[index] ?? 0) > density;
    if (above && start < 0) start = index;
    if (!above && start >= 0) {
      if (index - start >= minRun) runs.push({ from: start, to: index });
      start = -1;
    }
  }
  if (start >= 0 && values.length - start >= minRun) {
    runs.push({ from: start, to: values.length });
  }
  return runs;
}

/**
 * 把欄方向的內容區段分成「主體」與「右側軸」。
 *
 * 價格軸在畫面最右側，與 K 線之間隔著一段會隨時間變動的空白。
 * 最後一個區段若確實靠近右緣、且與前一段之間有明顯間隙，就視為軸。
 */
function splitBodyAndAxis(runs: readonly Range[], width: number): {
  body: Range;
  axis?: Range;
} {
  if (runs.length === 0) return { body: { from: 0, to: width } };

  const last = runs[runs.length - 1] as Range;
  const nearRightEdge = last.to >= width * 0.95;
  const previous = runs[runs.length - 2];

  if (runs.length >= 2 && nearRightEdge && previous !== undefined) {
    const gap = last.from - previous.to;
    if (gap >= width * 0.02) {
      const first = runs[0] as Range;
      return { body: { from: first.from, to: previous.to }, axis: last };
    }
  }

  const first = runs[0] as Range;
  return { body: { from: first.from, to: last.to } };
}

/**
 * 找出畫面上內容的分佈。純函式：吃灰階像素緩衝，不碰檔案系統。
 */
export function detectContentLayout(
  gray: Uint8Array,
  width: number,
  height: number,
  options: DetectOptions = {},
): ContentLayout {
  const threshold = options.threshold ?? DEFAULTS.threshold;
  const density = options.density ?? DEFAULTS.density;
  const minRun = options.minRun ?? DEFAULTS.minRun;

  const { columns, rows } = project(gray, width, height, threshold);
  const columnRuns = runsAbove(columns, density, minRun);
  const rowRuns = runsAbove(rows, density, minRun);

  const { body, axis } = splitBodyAndAxis(columnRuns, width);
  const vertical =
    rowRuns.length === 0
      ? { from: 0, to: height }
      : {
          from: (rowRuns[0] as Range).from,
          to: (rowRuns[rowRuns.length - 1] as Range).to,
        };

  return { body, vertical, ...(axis === undefined ? {} : { axis }) };
}
