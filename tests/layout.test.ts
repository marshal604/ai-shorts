import { describe, expect, it } from 'vitest';
import { BANDS, CANVAS, OUTPUT_FPS } from '../src/render/layout.ts';

describe('直式版面', () => {
  it('是短影音平台的標準尺寸', () => {
    expect(CANVAS).toEqual({ width: 1080, height: 1920 });
  });

  it('四個帶狀區依序不重疊', () => {
    const bands = [BANDS.title, BANDS.chart, BANDS.subtitle, BANDS.platformUi];
    for (let index = 1; index < bands.length; index += 1) {
      const previous = bands[index - 1]!;
      expect(bands[index]!.y).toBeGreaterThanOrEqual(previous.y + previous.height);
    }
  });

  it('所有帶狀區都在畫布內', () => {
    for (const band of Object.values(BANDS)) {
      expect(band.y + band.height).toBeLessThanOrEqual(CANVAS.height);
    }
  });

  it('底部保留給平台 UI 的區塊夠大 —— 標題與描述會蓋住那裡', () => {
    expect(BANDS.platformUi.height).toBeGreaterThan(300);
  });

  it('輸出影格率適合短影音平台', () => {
    expect(OUTPUT_FPS).toBeGreaterThanOrEqual(24);
  });
});
