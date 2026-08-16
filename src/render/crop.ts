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

// ── 介面元件偵測 ───────────────────────────────────────────────────

/**
 * 貼在畫面**左右**兩側的介面元件佔的比例。
 *
 * 這些不能靠單幀的投影分出來：工具列有圖示，在投影上就是「內容」，
 * 而且與圖表之間往往沒有空隙。但它有一個單幀看不到的特徵 ——
 * **它不會動**。抽幾張時間相隔很遠的畫面，變動的是圖表，不變的是介面。
 *
 * 這樣就不必假設版面固定，也不必請使用者填設定；換看盤軟體、換版面配置
 * 都自動成立。
 *
 * **只做水平方向。** 垂直方向由單幀投影負責，因為兩個訊號各自失效的地方
 * 剛好互補：水平上工具列緊貼圖表、中間沒有空隙，投影分不出來；垂直上
 * 工具列與圖表之間有大片留白，而**空白也是靜止的**，動態偵測會一路吃進
 * 那片留白（實測頂部量到 6.7%，真值只有 4.7%）。
 */
export interface ChromeInsets {
  readonly left: number;
  readonly right: number;
}

export interface ChromeOptions {
  /** 像素差超過多少才算「變動」。 */
  readonly changeThreshold?: number;
  /**
   * 介面區塊的變動率上限，相對於內容的變動率中位數。
   *
   * 用相對值而非絕對值：工具列**不是**完全靜止 —— 不同時間點有不同的
   * 工具被高亮、游標會經過。實測工具列的變動率是 8%、圖表是 15–27%，
   * 用 1% 的絕對門檻會在工具列第一欄就停下，嚴重低估厚度。
   */
  readonly relativeStillness?: number;
  /** 連續多少像素才算一個介面區塊。 */
  readonly minRun?: number;
  /** 單邊最多能吃掉畫面的多少比例 —— 防止整幅靜止的畫面被判成全是介面。 */
  readonly maxInsetRatio?: number;
}

const CHROME_DEFAULTS = {
  changeThreshold: 12,
  relativeStillness: 0.5,
  minRun: 4,
  maxInsetRatio: 0.2,
} as const;

/** 內容的變動率基準。取中位數，避免被大片不動的背景或單一極端值拉走。 */
function medianChange(values: Float64Array): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** 每一欄與每一列在多幀之間變動的像素比例。 */
function changeProfile(
  frames: readonly Uint8Array[],
  width: number,
  height: number,
  threshold: number,
): { columns: Float64Array; rows: Float64Array } {
  const columns = new Float64Array(width);
  const rows = new Float64Array(height);

  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      let changed = false;
      for (let index = 1; index < frames.length && !changed; index += 1) {
        const previous = frames[index - 1]?.[offset + x] ?? 0;
        const current = frames[index]?.[offset + x] ?? 0;
        if (Math.abs(current - previous) > threshold) changed = true;
      }
      if (changed) {
        columns[x] = (columns[x] ?? 0) + 1;
        rows[y] = (rows[y] ?? 0) + 1;
      }
    }
  }

  for (let x = 0; x < width; x += 1) columns[x] = (columns[x] ?? 0) / height;
  for (let y = 0; y < height; y += 1) rows[y] = (rows[y] ?? 0) / width;
  return { columns, rows };
}

/**
 * 從一端往內量出介面元件的厚度。
 *
 * 不能一碰到會變動的欄就停：工具列裡也有東西會動（游標經過、工具被選取
 * 而高亮），停在第一個變動處會嚴重低估。實測同一套版面在兩支影片上量到
 * 3.4% 與 0.8%，差距全來自這件事。
 *
 * 改為看**累積平均**：只要從邊緣算起的平均變動率仍低於門檻就繼續往內，
 * 並記住最後一個仍然合格的位置。零星的變動被平均稀釋，真正進入圖表區時
 * 變動率會急升而停下。
 */
function leadingStill(
  change: Float64Array,
  ceiling: number,
  minRun: number,
  limit: number,
  reverse: boolean,
): number {
  if (ceiling <= 0) return 0;
  const size = change.length;
  const maximum = Math.floor(size * limit);
  let total = 0;
  let best = 0;

  for (let step = 0; step < maximum; step += 1) {
    const index = reverse ? size - 1 - step : step;
    total += change[index] ?? 1;
    if (total / (step + 1) < ceiling) best = step + 1;
  }

  return best < minRun ? 0 : best / size;
}

/**
 * 抽樣幾張時間相隔很遠的畫面，找出四邊不會動的介面元件。
 * 幀數少於兩張時回傳全零 —— 沒有比較對象就無從判斷，
 * 此時寧可什麼都不裁，也不要憑空猜一個比例。
 */
export function detectChrome(
  frames: readonly Uint8Array[],
  width: number,
  height: number,
  options: ChromeOptions = {},
): ChromeInsets {
  if (frames.length < 2) return { left: 0, right: 0 };

  const threshold = options.changeThreshold ?? CHROME_DEFAULTS.changeThreshold;
  const relative = options.relativeStillness ?? CHROME_DEFAULTS.relativeStillness;
  const minRun = options.minRun ?? CHROME_DEFAULTS.minRun;
  const limit = options.maxInsetRatio ?? CHROME_DEFAULTS.maxInsetRatio;

  const { columns } = changeProfile(frames, width, height, threshold);
  const ceiling = medianChange(columns) * relative;

  return {
    left: leadingStill(columns, ceiling, minRun, limit, false),
    right: leadingStill(columns, ceiling, minRun, limit, true),
  };
}
