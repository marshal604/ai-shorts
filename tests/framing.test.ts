import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectChrome, detectContentLayout } from '../src/render/crop.ts';
import { framingWidth, placeInChartBand, planFraming } from '../src/render/framing.ts';
import { BANDS, CANVAS } from '../src/render/layout.ts';
import type { ChromeInsets } from '../src/render/crop.ts';

const SAMPLE = { width: 640, height: 358 } as const;
const SOURCE = { width: 3258, height: 1826 } as const;
const NO_CHROME: ChromeInsets = { left: 0, right: 0 };

function layoutOf(name: string) {
  const gray = new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.gray`, import.meta.url))),
  );
  return detectContentLayout(gray, SAMPLE.width, SAMPLE.height);
}

const plan = (name: string, mode: 'full' | 'roi', chrome: ChromeInsets = NO_CHROME) =>
  planFraming(layoutOf(name), chrome, mode, SOURCE.width, SOURCE.height, SAMPLE.width, SAMPLE.height);

const isEven = (value: number) => value % 2 === 0;

describe('裁切框換算', () => {
  it('所有尺寸與位移都是偶數 —— 編碼器要求', () => {
    for (const name of ['chart-0140', 'chart-0044']) {
      for (const mode of ['full', 'roi'] as const) {
        const framing = plan(name, mode);
        for (const value of [framing.body.x, framing.body.y, framing.body.width, framing.body.height]) {
          expect(isEven(value)).toBe(true);
        }
      }
    }
  });

  it('裁切框不會超出來源畫面', () => {
    for (const name of ['chart-0140', 'chart-0044']) {
      for (const mode of ['full', 'roi'] as const) {
        const framing = plan(name, mode);
        expect(framing.body.x + framing.body.width).toBeLessThanOrEqual(SOURCE.width);
        expect(framing.body.y + framing.body.height).toBeLessThanOrEqual(SOURCE.height);
        if (framing.axis !== undefined) {
          expect(framing.axis.x + framing.axis.width).toBeLessThanOrEqual(SOURCE.width);
        }
      }
    }
  });

  it('沒有偵測到價格軸時裁到畫面右緣 —— 寧可留白也不要丟掉價位', () => {
    const framing = plan('chart-0140', 'roi');
    expect(framing.axis).toBeUndefined();
    expect(framing.body.x + framing.body.width).toBeGreaterThanOrEqual(SOURCE.width - 8);
  });

  it('偵測到價格軸時主體止於軸之前，兩塊分開裁再併攏', () => {
    const framing = plan('chart-0044', 'roi');
    expect(framing.axis).toBeDefined();
    expect(framing.body.x + framing.body.width).toBeLessThanOrEqual(framing.axis!.x);
  });

  it('放大模式取主體的右半，全幅模式從左緣開始', () => {
    const full = plan('chart-0044', 'full');
    const roi = plan('chart-0044', 'roi');
    expect(roi.body.x).toBeGreaterThan(full.body.x);
    expect(roi.body.width).toBeLessThan(full.body.width);
  });

  it('介面元件的比例會把裁切往內推', () => {
    const withoutChrome = plan('chart-0044', 'full');
    const withChrome = plan('chart-0044', 'full', { left: 0.05, right: 0 });
    expect(withChrome.body.x).toBeGreaterThan(withoutChrome.body.x);
  });

  it('併攏後的寬度是主體加上軸', () => {
    const framing = plan('chart-0044', 'roi');
    expect(framingWidth(framing)).toBe(framing.body.width + framing.axis!.width);
  });
});

describe('置入圖表帶', () => {
  it('等比縮放後不超出圖表帶', () => {
    for (const [width, height] of [[2000, 1500], [3258, 1826], [800, 2000]] as const) {
      const place = placeInChartBand(width, height);
      expect(place.scaledWidth).toBeLessThanOrEqual(CANVAS.width);
      expect(place.scaledHeight).toBeLessThanOrEqual(BANDS.chart.height);
    }
  });

  it('置中，且補邊區不會被推出畫布', () => {
    const place = placeInChartBand(3258, 1826);
    expect(place.offsetX + place.scaledWidth).toBeLessThanOrEqual(CANVAS.width);
    expect(place.offsetY + place.scaledHeight).toBeLessThanOrEqual(CANVAS.height);
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
    expect(chrome.left).toBeLessThan(0.06);
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
