import { describe, expect, it } from 'vitest';
import { buildSpans, collapseRepeats, pairAnchors } from '../src/anchors/spans.ts';
import { trading } from '../src/categories/trading.ts';
import type { Anchor } from '../src/types.ts';

const open = (at: number): Anchor => ({ at, role: 'open', eventId: 'entry', excerpt: '這筆進場' });
const close = (at: number, outcome = '止損', eventId = 'stop-loss'): Anchor => ({
  at,
  role: 'close',
  eventId,
  outcome,
  excerpt: '這筆止損',
});

describe('重複喊的錨點', () => {
  it('相隔數秒的同一個事件收斂成一個', () => {
    // 實測：講者說完「那這筆我們就是止盈」兩秒後又說「這筆止盈，所以 1.27R 我們拿到了」
    expect(collapseRepeats([close(316), close(318)]).kept).toHaveLength(1);
  });

  it('相隔數分鐘的同角色錨點不收斂 —— 那是兩筆交易，不是重複', () => {
    // 沒有時間窗的話，漏掉一個開始錨點會讓兩筆交易的結束被併成一個，兩筆一起消失。
    expect(collapseRepeats([close(316), close(606)]).kept).toHaveLength(2);
  });

  it('不同角色不會被收斂', () => {
    expect(collapseRepeats([open(100), close(110)]).kept).toHaveLength(2);
  });

  it('不同事件不會被收斂 —— 先部分止盈再全部止盈是兩件事', () => {
    const partial = close(600, '部分止盈', 'partial-take-profit');
    const full = close(645, '止盈', 'take-profit');
    expect(collapseRepeats([partial, full]).kept).toHaveLength(2);
  });

  it('被當成重複丟掉的錨點會被交出來，不會憑空消失', () => {
    const { kept, dropped } = collapseRepeats([close(316), close(318)]);
    expect(kept).toHaveLength(1);
    expect(dropped.map((anchor) => anchor.at)).toEqual([318]);
  });
});

describe('錨點配對', () => {
  it('開始接著結束成為一個區段', () => {
    const { pairs, unpaired } = pairAnchors([open(100), close(200)]);
    expect(pairs).toHaveLength(1);
    expect(unpaired).toHaveLength(0);
  });

  it('多筆交易依序配對', () => {
    const { pairs } = pairAnchors([open(10), close(20), open(30), close(40)]);
    expect(pairs.map((pair) => [pair.open.at, pair.close.at])).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it('沒有開始的結束落單，不會被硬配給別人', () => {
    const { pairs, unpaired } = pairAnchors([close(100), open(200), close(300)]);
    expect(pairs).toHaveLength(1);
    expect(unpaired.map((anchor) => anchor.at)).toEqual([100]);
  });

  it('沒有結束的開始落單', () => {
    const { pairs, unpaired } = pairAnchors([open(100)]);
    expect(pairs).toHaveLength(0);
    expect(unpaired.map((anchor) => anchor.at)).toEqual([100]);
  });

  it('連續兩個開始時前一個落單 —— 代表漏喊了結束', () => {
    const { pairs, unpaired } = pairAnchors([open(10), open(50), close(80)]);
    expect(pairs.map((pair) => pair.open.at)).toEqual([50]);
    expect(unpaired.map((anchor) => anchor.at)).toEqual([10]);
  });
});

describe('區段與取材窗口', () => {
  const duration = 900;

  it('結果標籤來自結束錨點', () => {
    const { spans } = buildSpans([open(300), close(360, '止盈')], trading, duration);
    expect(spans[0]?.outcome).toBe('止盈');
  });

  it('窗口不會越過區段自己的兩端', () => {
    const { spans } = buildSpans([open(300), close(360)], trading, duration);
    const window = spans[0]?.window;
    expect(window?.openTo).toBeLessThanOrEqual(360);
    expect(window?.closeFrom).toBeGreaterThanOrEqual(300);
  });

  it('窗口碰到鄰近區段的錨點就截斷，兩段取材互不重疊', () => {
    const { spans } = buildSpans(
      [open(300), close(360), open(380), close(440)],
      trading,
      duration,
    );
    const first = spans[0]?.window;
    const second = spans[1]?.window;
    expect(first?.closeTo).toBeLessThanOrEqual(380);
    expect(second?.openFrom).toBeGreaterThanOrEqual(360);
  });

  it('窗口不會伸出影片之外', () => {
    const { spans } = buildSpans([open(20), close(60)], trading, 200);
    expect(spans[0]?.window.openFrom).toBeGreaterThanOrEqual(0);
    expect(spans[0]?.window.closeTo).toBeLessThanOrEqual(200);
  });

  it('落單的錨點不會產生區段，但會被保留下來讓使用者看見', () => {
    const { spans, unpaired } = buildSpans([close(316), close(606)], trading, duration);
    expect(spans).toHaveLength(0);
    expect(unpaired).toHaveLength(2);
  });
});
