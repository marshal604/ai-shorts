import { describe, expect, it } from 'vitest';
import { BANDS, CANVAS, chartPlacement } from '../src/render/layout.ts';

// 使用者實際的螢幕錄影尺寸（不是標準 16:9）
const SOURCE = { width: 3258, height: 1826 } as const;

const isEven = (value: number) => value % 2 === 0;

describe('圖表版面', () => {
  it('裁切與縮放後的尺寸都是偶數 —— 編碼器要求', () => {
    for (const mode of ['full', 'roi'] as const) {
      const place = chartPlacement(SOURCE.width, SOURCE.height, mode);
      expect(isEven(place.crop.width)).toBe(true);
      expect(isEven(place.crop.height)).toBe(true);
      expect(isEven(place.scaledWidth)).toBe(true);
      expect(isEven(place.scaledHeight)).toBe(true);
    }
  });

  it('圖表不會超出圖表帶', () => {
    for (const mode of ['full', 'roi'] as const) {
      const place = chartPlacement(SOURCE.width, SOURCE.height, mode);
      expect(place.scaledHeight).toBeLessThanOrEqual(BANDS.chart.height);
      expect(place.scaledWidth).toBeLessThanOrEqual(CANVAS.width);
    }
  });

  it('圖表置中於圖表帶，不會蓋到平台 UI 保留區', () => {
    for (const mode of ['full', 'roi'] as const) {
      const place = chartPlacement(SOURCE.width, SOURCE.height, mode);
      expect(place.offsetY).toBeGreaterThanOrEqual(BANDS.chart.y - 1);
      expect(place.offsetY + place.scaledHeight).toBeLessThanOrEqual(BANDS.platformUi.y);
    }
  });

  it('放大模式比全幅模式讓圖表更大 —— 這是它存在的理由', () => {
    const full = chartPlacement(SOURCE.width, SOURCE.height, 'full');
    const roi = chartPlacement(SOURCE.width, SOURCE.height, 'roi');
    expect(roi.scaledHeight).toBeGreaterThan(full.scaledHeight);
  });

  it('全幅模式裁掉工具列，不是原封不動塞進畫面', () => {
    const full = chartPlacement(SOURCE.width, SOURCE.height, 'full');
    expect(full.crop.width).toBeLessThan(SOURCE.width);
    expect(full.crop.height).toBeLessThan(SOURCE.height);
    expect(full.crop.y).toBeGreaterThan(0);
  });

  it('放大模式取畫面右側 —— 價格與進場點在那裡', () => {
    const roi = chartPlacement(SOURCE.width, SOURCE.height, 'roi');
    expect(roi.crop.x).toBeGreaterThan(SOURCE.width / 4);
    expect(roi.crop.x + roi.crop.width).toBeGreaterThanOrEqual(SOURCE.width - 2);
  });

  it('裁切框不會超出來源畫面', () => {
    for (const mode of ['full', 'roi'] as const) {
      const place = chartPlacement(SOURCE.width, SOURCE.height, mode);
      expect(place.crop.x + place.crop.width).toBeLessThanOrEqual(SOURCE.width);
      expect(place.crop.y + place.crop.height).toBeLessThanOrEqual(SOURCE.height);
    }
  });

  it('換一個來源尺寸也成立 —— 比例而非像素（ADR-0003）', () => {
    const place = chartPlacement(1920, 1080, 'roi');
    expect(place.crop.x + place.crop.width).toBeLessThanOrEqual(1920);
    expect(place.scaledHeight).toBeLessThanOrEqual(BANDS.chart.height);
  });

  it('圖表剛好等寬時位移為 0，不會把補邊區推出畫布', () => {
    // 位移若沿用尺寸的下限 2，pad 的輸入區會結束在 1082，超出 1080 的畫布；
    // 部分 ffmpeg 版本會直接拒絕整張濾鏡圖而不是默默夾回去。
    const place = chartPlacement(SOURCE.width, SOURCE.height, 'roi');
    expect(place.scaledWidth).toBe(CANVAS.width);
    expect(place.offsetX).toBe(0);
  });

  it('補邊後的圖表永遠落在畫布內', () => {
    for (const [width, height] of [
      [3258, 1826],
      [1920, 1080],
      [2560, 1440],
      [1280, 720],
    ] as const) {
      for (const mode of ['full', 'roi'] as const) {
        const place = chartPlacement(width, height, mode);
        expect(place.offsetX + place.scaledWidth).toBeLessThanOrEqual(CANVAS.width);
        expect(place.offsetY + place.scaledHeight).toBeLessThanOrEqual(CANVAS.height);
      }
    }
  });

  it('任何來源寬度下裁切框都不會超出畫面右緣', () => {
    // 起點與寬度各自取偶數時，兩者相加可能多出 2px；
    // ffmpeg 會默默夾回去，導致取景悄悄偏移而不是報錯。
    const offenders: number[] = [];
    for (let width = 640; width <= 4096; width += 2) {
      for (const mode of ['full', 'roi'] as const) {
        const place = chartPlacement(width, 1080, mode);
        if (place.crop.x + place.crop.width > width) offenders.push(width);
      }
    }
    expect(offenders).toEqual([]);
  });
});
