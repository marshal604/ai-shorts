import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectChrome, detectContentLayout } from '../src/render/crop.ts';
import {
  CHART_RECT,
  conformToChartAspect,
  framingWidth,
  placeInChartBand,
  planFraming,
} from '../src/render/framing.ts';
import { BANDS, CANVAS } from '../src/render/layout.ts';
import type { ChromeInsets } from '../src/render/crop.ts';

const SAMPLE = { width: 640, height: 358 } as const;
const SOURCE = { width: 3258, height: 1826 } as const;
const NO_CHROME: ChromeInsets = { left: 0, right: 0 };
const FRAMES = ['chart-0140', 'chart-0044'] as const;

function layoutOf(name: string) {
  const gray = new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.gray`, import.meta.url))),
  );
  return detectContentLayout(gray, SAMPLE.width, SAMPLE.height);
}

const plan = (name: string, chrome: ChromeInsets = NO_CHROME) =>
  planFraming(layoutOf(name), chrome, SOURCE.width, SOURCE.height, SAMPLE.width, SAMPLE.height);

const conformed = (name: string, chrome: ChromeInsets = NO_CHROME) =>
  conformToChartAspect(plan(name, chrome), SOURCE.width, SOURCE.height);

const isEven = (value: number) => value % 2 === 0;

describe('裁切框換算', () => {
  it('所有尺寸與位移都是偶數 —— 編碼器要求', () => {
    for (const name of FRAMES) {
      const { body } = plan(name);
      for (const value of [body.x, body.y, body.width, body.height]) {
        expect(isEven(value)).toBe(true);
      }
    }
  });

  it('裁切框不會超出來源畫面', () => {
    for (const name of FRAMES) {
      const framing = plan(name);
      expect(framing.body.x + framing.body.width).toBeLessThanOrEqual(SOURCE.width);
      expect(framing.body.y + framing.body.height).toBeLessThanOrEqual(SOURCE.height);
      if (framing.axis !== undefined) {
        expect(framing.axis.x + framing.axis.width).toBeLessThanOrEqual(SOURCE.width);
      }
    }
  });

  it('沒有偵測到價格軸時裁到畫面右緣 —— 寧可留白也不要丟掉價位', () => {
    // 用合成的 layout 直接驗這條退路，不綁在某張 fixture 上：
    // 軸偵測修好之後兩張 fixture 都切得出軸了，但退路本身仍然要成立。
    const noAxis = { body: { from: 0, to: 300 }, vertical: { from: 20, to: 340 } };
    const framing = planFraming(
      noAxis,
      NO_CHROME,
      SOURCE.width,
      SOURCE.height,
      SAMPLE.width,
      SAMPLE.height,
    );
    expect(framing.axis).toBeUndefined();
    expect(framing.body.x + framing.body.width).toBeGreaterThanOrEqual(SOURCE.width - 8);
  });

  it('偵測到價格軸時主體止於軸之前，兩塊分開裁再併攏', () => {
    const framing = plan('chart-0044');
    expect(framing.axis).toBeDefined();
    expect(framing.body.x + framing.body.width).toBeLessThanOrEqual(framing.axis!.x);
  });

  it('介面元件的比例會把裁切往內推', () => {
    expect(plan('chart-0044', { left: 0.05, right: 0 }).body.x).toBeGreaterThan(
      plan('chart-0044').body.x,
    );
  });

  it('併攏後的寬度是主體加上軸', () => {
    const framing = plan('chart-0044');
    expect(framingWidth(framing)).toBe(framing.body.width + framing.axis!.width);
  });
});

describe('共用的圖表矩形', () => {
  it('整支片只有一個矩形 —— 每段各自適配會讓畫面忽大忽小、上下亂跑', () => {
    expect(placeInChartBand()).toEqual(CHART_RECT);
  });

  it('矩形佔滿寬度、置中於圖表帶且不越界', () => {
    expect(CHART_RECT.scaledWidth).toBe(CANVAS.width);
    expect(CHART_RECT.scaledHeight).toBeLessThanOrEqual(BANDS.chart.height);
    expect(CHART_RECT.offsetY).toBeGreaterThanOrEqual(BANDS.chart.y);
    expect(CHART_RECT.offsetY + CHART_RECT.scaledHeight).toBeLessThanOrEqual(
      BANDS.chart.y + BANDS.chart.height,
    );
  });

  it('矩形填滿整個圖表帶 —— 少用的每一列都是白白浪費的畫面', () => {
    expect(CHART_RECT.scaledHeight).toBe(BANDS.chart.height);
  });

  it('矩形的比例貼近 K 線區的實測比例 —— 差太多會砍掉大量內容', () => {
    // 曾經是 1.74，但那是死留白還被算成內容時量的（主體幾乎等於整幅寬度，
    // 自然接近來源的 3258:1826）。排除死留白後重量，K 線區是 0.66 到 1.16。
    const aspect = CHART_RECT.scaledWidth / CHART_RECT.scaledHeight;
    expect(aspect).toBeGreaterThan(1.15);
    expect(aspect).toBeLessThan(1.5);
  });

  it('每個片段的裁切框都被調成同一個長寬比', () => {
    const target = CHART_RECT.scaledWidth / CHART_RECT.scaledHeight;
    for (const name of FRAMES) {
      const framing = conformed(name);
      expect(framingWidth(framing) / framing.body.height).toBeCloseTo(target, 1);
    }
  });

  it('調整後仍不超出來源畫面', () => {
    for (const name of FRAMES) {
      const framing = conformed(name);
      expect(framing.body.x).toBeGreaterThanOrEqual(0);
      expect(framing.body.y).toBeGreaterThanOrEqual(0);
      expect(framing.body.x + framing.body.width).toBeLessThanOrEqual(SOURCE.width);
      expect(framing.body.y + framing.body.height).toBeLessThanOrEqual(SOURCE.height);
    }
  });

  it('湊比例時寧可往左擴，也不要把高度砍到蓋不住價格行為', () => {
    // 舊規則是「保留寬度、調整高度」。內容偵測收緊之後，那條規則會把
    // 1044 寬的裁切配成 599 高，而內容的垂直範圍是 1734 —— 三分之二的
    // 價格行為被切掉。現在改成高度優先，寬度往左補。
    for (const name of FRAMES) {
      const before = plan(name);
      const after = conformed(name);
      expect(after.body.height).toBeGreaterThan(before.body.height / 2);
      expect(after.body.width).toBeGreaterThanOrEqual(before.body.width);
    }
  });

  it('往左擴不會越過工具列的界線', () => {
    const leftBound = 240;
    for (const name of FRAMES) {
      const framing = conformToChartAspect(plan(name), SOURCE.width, SOURCE.height, leftBound);
      expect(framing.body.x).toBeGreaterThanOrEqual(leftBound);
    }
  });

  it('比例一定湊得準 —— filtergraph 直接 scale 到矩形，比例對不上就是把 K 線壓扁', () => {
    const target = CHART_RECT.scaledWidth / CHART_RECT.scaledHeight;
    for (const name of FRAMES) {
      const framing = conformed(name);
      expect(framingWidth(framing) / framing.body.height).toBeCloseTo(target, 2);
    }
  });

  it('右緣不動 —— 那裡是價格軸與最新的 K 棒', () => {
    for (const name of FRAMES) {
      const before = plan(name);
      const after = conformed(name);
      const rightOf = (f: typeof before) =>
        f.axis === undefined ? f.body.x + f.body.width : f.axis.x + f.axis.width;
      expect(rightOf(after)).toBe(rightOf(before));
    }
  });

  it('上緣不會往回退 —— 內容偵測排除掉的頂部工具列不可以被吃回來', () => {
    for (const name of FRAMES) {
      expect(conformed(name).body.y).toBeGreaterThanOrEqual(plan(name).body.y);
    }
  });

  it('高度以內容的垂直中心為準 —— 價格行為要留在畫面裡', () => {
    const before = plan('chart-0044');
    const after = conformed('chart-0044');
    const centreBefore = before.body.y + before.body.height / 2;
    const centreAfter = after.body.y + after.body.height / 2;
    expect(Math.abs(centreAfter - centreBefore)).toBeLessThan(60);
  });
});

describe('介面元件偵測', () => {
  const frames = [1, 2, 3].map(
    (index) =>
      new Uint8Array(
        readFileSync(fileURLToPath(new URL(`./fixtures/chrome-${index}.gray`, import.meta.url))),
      ),
  );

  it('從真實錄影量出左側工具列，而不是靠假設', () => {
    const chrome = detectChrome(frames, 320, 180);
    expect(chrome.left).toBeGreaterThan(0.02);
    expect(chrome.left).toBeLessThan(0.08);
  });

  it('會變動的邊不算介面 —— 價格軸每一幀都在動', () => {
    expect(detectChrome(frames, 320, 180).right).toBe(0);
  });

  it('只有一張畫面時不猜 —— 沒有比較對象就不該裁掉任何東西', () => {
    expect(detectChrome([frames[0]!], 320, 180)).toEqual({ left: 0, right: 0 });
  });

  it('完全靜止的畫面不會被判成整幅都是介面', () => {
    const still = new Uint8Array(320 * 180).fill(40);
    const chrome = detectChrome([still, still, still], 320, 180);
    expect(chrome.left).toBeLessThanOrEqual(0.2);
    expect(chrome.right).toBeLessThanOrEqual(0.2);
  });
});
