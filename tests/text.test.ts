import { describe, expect, it } from 'vitest';
import { buildCardSvg, emphasize, renderCardPng, wrapChinese } from '../src/render/text.ts';
import { BANDS, CANVAS } from '../src/render/layout.ts';
import type { Card } from '../src/types.ts';

describe('中文斷行', () => {
  it('每行不超過指定字數', () => {
    const lines = wrapChinese('流動性上下掃完之後等回踩訊號再進場做多', 8);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(9); // 允許為了標點多帶一字
    }
  });

  it('不會漏字 —— 斷行處的空白會被吃掉，但沒有實質內容遺失', () => {
    const text = '停損放在下緣，TP1 是 1.19，TP2 是 4.79';
    const strip = (value: string) => value.replace(/\s+/g, '');
    expect(strip(wrapChinese(text, 10).join(''))).toBe(strip(text));
  });

  it('標點不會被推到行首', () => {
    const lines = wrapChinese('沒有守住，一根就打掉了啊', 5);
    for (const line of lines) {
      expect('。，、；：！？）」').not.toContain(line[0] as string);
    }
  });

  it('短文字維持單行', () => {
    expect(wrapChinese('進場：多單', 15)).toEqual(['進場：多單']);
  });

  it('空字串產出零行，不是一行空的', () => {
    expect(wrapChinese('   ', 12)).toEqual([]);
  });

  it('不會把數字拆開 —— 「1.19」不能變成「1.」「19」', () => {
    for (const line of wrapChinese('SL 止損 · RR 1.19', 13)) {
      expect(line).not.toMatch(/\d\.$/);
      expect(line).not.toMatch(/^\d+$/);
    }
    expect(wrapChinese('SL 止損 · RR 1.19', 13).join('')).toContain('1.19');
  });

  it('不會把英文詞拆開 —— 「FVG」不能變成「FV」「G」', () => {
    const lines = wrapChinese('流動性掃過，這裡留下一個 FVG', 13);
    expect(lines.some((line) => line.includes('FVG'))).toBe(true);
    expect(lines).not.toContain('G');
  });

  it('含逗號的價位視為一個整體', () => {
    const lines = wrapChinese('價格來到 4,038.2 附近有反應', 8);
    expect(lines.some((line) => line.includes('4,038.2'))).toBe(true);
  });

  it('最後一行不會只剩一個孤字', () => {
    const lines = wrapChinese('盤面：等 0.382 的反應', 13);
    expect((lines[lines.length - 1] as string).length).toBeGreaterThan(1);
  });

  it('連續標點不會把整行推出畫布', () => {
    for (const line of wrapChinese('好的。。。…。結束了呢', 5)) {
      expect(line.length).toBeLessThanOrEqual(8);
    }
  });
});

describe('數字強調', () => {
  it('價位被標記成強調段落', () => {
    expect(emphasize('價格來到 4,038.2')).toContain('<tspan');
    expect(emphasize('價格來到 4,038.2')).toContain('4,038.2');
  });

  it('R 值被標記成強調段落', () => {
    expect(emphasize('結果 -1.0R')).toMatch(/<tspan[^>]*>-1\.0R<\/tspan>/);
  });

  it('沒有數字時不產生強調段落', () => {
    expect(emphasize('方向做錯了')).not.toContain('<tspan');
  });

  it('標籤裡的序號不算數字 —— TP1 的 1 不是價位', () => {
    const marked = emphasize('停損放在下緣，TP1 1.19、TP2 4.79');
    expect(marked).toContain('TP1');
    expect(marked).toContain('TP2');
    expect(marked).not.toContain('TP<tspan');
    expect(marked).toMatch(/<tspan[^>]*>1\.19<\/tspan>/);
    expect(marked).toMatch(/<tspan[^>]*>4\.79<\/tspan>/);
  });

  it('R 後面接中文時不會把空白吃進強調段落', () => {
    expect(emphasize('賺了 1.8 出場')).toMatch(/<tspan[^>]*>1\.8<\/tspan> 出場/);
  });

  it('非數字部分原樣保留', () => {
    expect(emphasize('停損 -1.0R 出場')).toContain('停損 ');
    expect(emphasize('停損 -1.0R 出場')).toContain(' 出場');
  });

  it('會跳脫 XML 特殊字元，不會產出壞掉的 SVG', () => {
    expect(emphasize('風險 < 報酬 & 機率')).toContain('&lt;');
    expect(emphasize('風險 < 報酬 & 機率')).toContain('&amp;');
  });
});

describe('文案卡圖層', () => {
  const title: Card = { kind: 'title', text: '結果：止損 -1.0R', start: 0, end: 3 };
  const caption: Card = { kind: 'caption', text: '方向做錯，這個盤本來就不好做', start: 0, end: 3 };

  it('產出整幅畫布大小的 SVG，方便直接疊在影像上', () => {
    const svg = buildCardSvg(title);
    expect(svg).toContain(`width="${CANVAS.width}"`);
    expect(svg).toContain(`height="${CANVAS.height}"`);
  });

  it('標題落在標題帶，字幕落在字幕帶', () => {
    const titleY = Number(/<text[^>]*y="([\d.]+)"/.exec(buildCardSvg(title))?.[1]);
    const captionY = Number(/<text[^>]*y="([\d.]+)"/.exec(buildCardSvg(caption))?.[1]);
    expect(titleY).toBeGreaterThan(BANDS.title.y);
    expect(titleY).toBeLessThan(BANDS.title.y + BANDS.title.height);
    expect(captionY).toBeGreaterThan(BANDS.subtitle.y);
    expect(captionY).toBeLessThan(BANDS.subtitle.y + BANDS.subtitle.height);
  });

  it('文字不會進入平台底部 UI 的遮蔽區', () => {
    for (const card of [title, caption]) {
      for (const match of buildCardSvg(card).matchAll(/<text[^>]*y="([\d.]+)"/g)) {
        expect(Number(match[1])).toBeLessThan(BANDS.platformUi.y);
      }
    }
  });

  it('字幕帶有底襯以保持可讀，標題沒有', () => {
    expect(buildCardSvg(caption)).toContain('<rect');
    expect(buildCardSvg(title)).not.toContain('<rect');
  });

  it('渲染出可用的 PNG', () => {
    const png = renderCardPng(title);
    expect(png.length).toBeGreaterThan(0);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  });
});
