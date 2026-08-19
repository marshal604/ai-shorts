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
  /**
   * 一欄裡最長的連續垂直內容段要佔畫面高度多少比例，才算「有結構」。
   *
   * 用來分辨 K 棒與虛線：K 棒的實體加影線在垂直方向是一整段，
   * 虛線不論橫的直的都只有一小截。實測 3258x1826 的 TradingView 錄影
   * （取樣成 640x358）：死留白區的最長段固定是 16 —— 那是 session
   * 分隔虛線的 dash 長度，整片留白裡每一欄都量得到；K 棒區在邊界處是
   * 19 到 24，中段可以到 286。取 0.05（約 18 列）落在兩者之間。
   */
  readonly structure?: number;
  /** 價格軸的欄密度下限。 */
  readonly axisDensity?: number;
}

const DEFAULTS = {
  threshold: 14,
  density: 0.012,
  minRun: 26,
  structure: 0.05,
  axisDensity: 0.25,
} as const;

/** 價格軸至少要這麼寬（佔畫面比例），否則視為雜訊。 */
const AXIS_MIN_WIDTH_RATIO = 0.012;

/** 價格軸必須從這個比例之後才開始 —— 它是貼著右緣的一條窄帶。 */
const AXIS_MIN_START_RATIO = 0.85;

/** 判定主體右界時，往回看幾欄找同伴，避免單一雜訊欄把邊界推出去。 */
const STRUCTURE_WINDOW = 16;

/** 一個窗口裡要有幾欄有結構，該處才算真的還在主體內。 */
const STRUCTURE_QUORUM = 2;

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
  /** 每一欄最長的連續垂直內容段，除以畫面高度。 */
  readonly structure: Float32Array;
}

function project(gray: Uint8Array, width: number, height: number, threshold: number): Projections {
  const columns = new Float32Array(width);
  const rows = new Float32Array(height);
  const structure = new Float32Array(width);
  const background = backgroundLevel(gray);
  // 逐欄累計「目前這一段連續內容有多長」，掃完就是該欄的最長段。
  const running = new Int32Array(width);

  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      if (Math.abs((gray[offset + x] ?? background) - background) > threshold) {
        columns[x] = (columns[x] ?? 0) + 1;
        rows[y] = (rows[y] ?? 0) + 1;
        running[x] = (running[x] ?? 0) + 1;
        if ((running[x] ?? 0) > (structure[x] ?? 0)) structure[x] = running[x] ?? 0;
      } else {
        running[x] = 0;
      }
    }
  }

  for (let x = 0; x < width; x += 1) {
    columns[x] = (columns[x] ?? 0) / height;
    structure[x] = (structure[x] ?? 0) / height;
  }
  for (let y = 0; y < height; y += 1) rows[y] = (rows[y] ?? 0) / width;
  return { columns, rows, structure };
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
 * 從右緣往內找價格軸。
 *
 * 不能靠「主體與軸之間有空隙」來切。replay 的死留白裡穿著整幅寬的水平
 * fib 虛線與垂直 session 分隔線，欄密度從來不歸零，主體與軸在投影上
 * 永遠連成同一段 —— 實測同一支影片的三個取樣點，有兩個切不開，於是
 * 一路裁到右緣，把三百多像素的死留白留在畫面上。
 *
 * 改用軸自己的特徵：它是一整排右對齊的價格標籤，欄密度實測 0.49–0.59，
 * 比 K 線區的 0.10–0.20 高一個量級。從右緣往內走到密度掉下門檻為止，
 * 不需要任何間隙。
 */
export function detectAxis(
  columns: Float32Array | readonly number[],
  width: number,
  axisDensity: number,
): Range | undefined {
  // 不能直接從最右一欄開始走：畫面最邊上通常有一兩欄空的留白，
  // 從那裡起掃第一步就會停下來，軸就永遠偵測不到。
  let end = -1;
  for (let x = width - 1; x >= Math.floor(width * AXIS_MIN_START_RATIO); x -= 1) {
    if ((columns[x] ?? 0) >= axisDensity) { end = x; break; }
  }
  if (end < 0) return undefined;

  let from = end;
  while (from > 0 && (columns[from - 1] ?? 0) >= axisDensity) from -= 1;

  const to = end + 1;
  if (to - from < width * AXIS_MIN_WIDTH_RATIO) return undefined;
  // 太寬就不是軸了 —— 多半是整幅畫面都很密（例如全螢幕的深色面板）。
  if (from < width * AXIS_MIN_START_RATIO) return undefined;
  return { from, to };
}

/**
 * 主體的右界：最後一欄仍然有「結構」的位置。
 *
 * 只看單欄會被雜訊拉走，所以要求往回 STRUCTURE_WINDOW 欄之內至少有
 * STRUCTURE_QUORUM 欄同樣有結構。
 */
function lastStructuralColumn(
  structure: Float32Array | readonly number[],
  limit: number,
  minimum: number,
): number {
  let last = -1;
  for (let x = 0; x < limit; x += 1) {
    if ((structure[x] ?? 0) <= minimum) continue;
    let peers = 0;
    for (let back = Math.max(0, x - STRUCTURE_WINDOW); back <= x; back += 1) {
      if ((structure[back] ?? 0) > minimum) peers += 1;
    }
    if (peers >= STRUCTURE_QUORUM) last = x;
  }
  return last;
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

  const structureFloor = options.structure ?? DEFAULTS.structure;
  const axisDensity = options.axisDensity ?? DEFAULTS.axisDensity;

  const { columns, rows, structure } = project(gray, width, height, threshold);
  const columnRuns = runsAbove(columns, density, minRun);
  const rowRuns = runsAbove(rows, density, minRun);

  const axis = detectAxis(columns, width, axisDensity);

  // 左界仍然用密度：那一側是工具列與最舊的 K 棒，沒有死留白的問題，
  // 而且 detectChrome 還會再把工具列推掉一次。
  const left = columnRuns[0]?.from ?? 0;
  // 右界只在軸的左邊找 —— 軸的文字本身也有結構，不先排除就會一路吃到右緣。
  const searchLimit = axis?.from ?? width;
  const structural = lastStructuralColumn(structure, searchLimit, structureFloor);

  // 找不到結構（整幅都是虛線或空白）時退回密度的右界，而不是回傳空框。
  const right = structural < 0 ? (columnRuns[columnRuns.length - 1]?.to ?? width) : structural + 1;
  const body: Range = { from: left, to: Math.max(left + 1, Math.min(right, searchLimit)) };

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
