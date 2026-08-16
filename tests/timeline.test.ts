import { describe, expect, it } from 'vitest';
import { buildTimeline, readingSeconds } from '../src/plan/timeline.ts';
import { positionBounds } from '../src/plan/plan.ts';
import { trading } from '../src/categories/trading.ts';
import type { Selection } from '../src/plan/timeline.ts';
import type { Span } from '../src/types.ts';

const pick = (over: Partial<Selection> = {}): Selection => ({
  positionId: 'entry',
  framing: 'roi',
  start: 100,
  end: 110,
  cardText: '空單進場',
  cardKind: 'caption',
  ...over,
});

describe('閱讀時間', () => {
  it('字越多需要越久', () => {
    expect(readingSeconds('一二三四五六七八九十一二三四五')).toBeGreaterThan(readingSeconds('一二三'));
  });

  it('短文字仍有最低停留時間 —— 一閃而過看不到', () => {
    expect(readingSeconds('好')).toBeGreaterThan(1);
  });
});

describe('時間軸推導', () => {
  it('文案長度決定片段長度，倍速由此推導', () => {
    const short = buildTimeline([pick({ cardText: '止盈' })]);
    const long = buildTimeline([pick({ cardText: '空單進場，止損設在下緣，目標拉到下方流動性' })]);
    // 同一段素材，文案越長就播得越慢（倍速越低），好讓人讀完。
    expect(short.cuts[0]?.speed ?? 1).toBeGreaterThan(long.cuts[0]?.speed ?? 1);
  });

  it('不做慢動作 —— 倍速不會低於原速', () => {
    const timeline = buildTimeline([pick({ start: 100, end: 102, cardText: '這是一段很長的文案需要讀很久才讀得完' })]);
    expect(timeline.cuts[0]?.speed ?? 1).toBeGreaterThanOrEqual(1);
  });

  it('素材再長也不會快過上限 —— 再快就看不出發生什麼', () => {
    const timeline = buildTimeline([pick({ start: 0, end: 600, cardText: '持倉' })]);
    expect(timeline.cuts[0]?.speed ?? 1).toBeLessThanOrEqual(8.001);
  });

  it('原速的片段不帶倍速欄位', () => {
    const timeline = buildTimeline([pick({ start: 100, end: 104, cardText: '一二三四五六七八九十一二三四五六七八' })]);
    expect(timeline.cuts[0]).not.toHaveProperty('speed');
  });

  it('文案卡的時間是成品時間軸，依序接續不重疊', () => {
    const timeline = buildTimeline([pick({ positionId: 'a' }), pick({ positionId: 'b' })]);
    expect(timeline.cards[0]?.start).toBe(0);
    expect(timeline.cards[0]?.end).toBe(timeline.cards[1]?.start);
    expect(timeline.durationSeconds).toBeCloseTo(timeline.cards[1]?.end ?? 0, 3);
  });

  it('長度為零的選材被略過，不會產出零長片段', () => {
    expect(buildTimeline([pick({ start: 100, end: 100 })]).cuts).toHaveLength(0);
  });
});

describe('取材上界', () => {
  const span: Span = {
    index: 1,
    openAt: 300,
    closeAt: 360,
    outcome: '止盈',
    window: { openFrom: 120, openTo: 360, closeFrom: 300, closeTo: 420 },
  };
  const byId = new Map(trading.skeleton.map((position) => [position.id, position]));

  it('before 只往錨點之前找', () => {
    const bounds = positionBounds(byId.get('context')!, span);
    expect(bounds.to).toBeLessThanOrEqual(span.openAt);
  });

  it('after 只往錨點之後找', () => {
    const bounds = positionBounds(byId.get('holding')!, span);
    expect(bounds.from).toBeGreaterThanOrEqual(span.openAt);
  });

  it('不會超出區段的取材窗口 —— 否則會剪到隔壁那筆交易', () => {
    for (const position of trading.skeleton) {
      const bounds = positionBounds(position, span);
      expect(bounds.from).toBeGreaterThanOrEqual(120);
      expect(bounds.to).toBeLessThanOrEqual(420);
    }
  });

  it('掛在結束錨點的位置以結束時間為中心', () => {
    const bounds = positionBounds(byId.get('reveal')!, span);
    expect(bounds.from).toBeLessThanOrEqual(span.closeAt);
    expect(bounds.to).toBeGreaterThanOrEqual(span.closeAt);
  });
});
