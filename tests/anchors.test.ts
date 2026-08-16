import { describe, expect, it } from 'vitest';
import { buildAnchors } from '../src/anchors/anchors.ts';
import { trading } from '../src/categories/trading.ts';
import type { MarkedEvent, Transcript, TranscriptSegment } from '../src/types.ts';

const segment = (start: number, text: string): TranscriptSegment => ({
  start,
  end: start + 2,
  text,
});

function transcript(
  segments: readonly TranscriptSegment[],
  events: readonly MarkedEvent[] = [],
): Transcript {
  return {
    source: { video: '/tmp/a.mov', durationSeconds: 900, engine: 'test' },
    language: 'zh',
    segments,
    events,
  };
}

describe('由標記事件建立錨點', () => {
  it('標記轉成錨點，時間取該段落的起點', () => {
    const { document } = buildAnchors({
      transcript: transcript(
        [segment(100, '那這筆進場'), segment(300, '這筆止盈')],
        [
          { segmentIndex: 0, eventId: 'entry', quote: '那這筆進場' },
          { segmentIndex: 1, eventId: 'take-profit', quote: '這筆止盈' },
        ],
      ),
      category: trading,
    });
    expect(document.anchors.map((anchor) => anchor.at)).toEqual([100, 300]);
    expect(document.spans).toHaveLength(1);
    expect(document.spans[0]?.outcome).toBe('止盈');
  });

  it('講者不必逐字照喊固定口令 —— 標記依語意而非字面', () => {
    const { document } = buildAnchors({
      transcript: transcript(
        [segment(100, '好我現在進場了'), segment(300, '這邊我們收掉，賺了一點')],
        [
          { segmentIndex: 0, eventId: 'entry', quote: '我現在進場了' },
          { segmentIndex: 1, eventId: 'take-profit', quote: '這邊我們收掉' },
        ],
      ),
      category: trading,
    });
    expect(document.spans).toHaveLength(1);
    expect(document.spans[0]?.outcome).toBe('止盈');
  });

  it('標記過但沒找到事件，就是零個錨點', () => {
    const { document } = buildAnchors({
      transcript: transcript([segment(100, '那這筆進場')], []),
      category: trading,
    });
    expect(document.anchors).toHaveLength(0);
    expect(document.spans).toHaveLength(0);
  });

  it('逐字稿沒經過標記階段時報錯 —— 靜靜產出空文件是無聲失敗', () => {
    const raw = {
      source: { video: '/tmp/a.mov', durationSeconds: 900, engine: 'test' },
      language: 'zh',
      segments: [segment(100, '那這筆進場')],
    } as const;
    expect(() => buildAnchors({ transcript: raw, category: trading })).toThrow(/標記/);
  });

  it('錨點時間依原句在段落中的位置內插，不是一律取段落起點', () => {
    const long: TranscriptSegment = { start: 100, end: 140, text: '前面講了很多廢話然後那這筆進場' };
    const { document } = buildAnchors({
      transcript: transcript(
        [long],
        [{ segmentIndex: 0, eventId: 'entry', quote: '那這筆進場' }],
      ),
      category: trading,
    });
    // 原句在段落後段，錨點時間應該明顯晚於段落起點。
    expect(document.anchors[0]?.at).toBeGreaterThan(120);
    expect(document.anchors[0]?.at).toBeLessThan(140);
  });

  it('指向不存在的事件 id 的標記被忽略', () => {
    const { document } = buildAnchors({
      transcript: transcript(
        [segment(100, '隨便')],
        [{ segmentIndex: 0, eventId: '不存在的事件', quote: '隨便' }],
      ),
      category: trading,
    });
    expect(document.anchors).toHaveLength(0);
  });

  it('指向不存在的段落的標記被忽略', () => {
    const { document } = buildAnchors({
      transcript: transcript(
        [segment(100, '那這筆進場')],
        [{ segmentIndex: 99, eventId: 'entry', quote: '那這筆進場' }],
      ),
      category: trading,
    });
    expect(document.anchors).toHaveLength(0);
  });
});

describe('交叉檢查', () => {
  it('前綴比對抓到但沒被標記的位置會被提出來', () => {
    const { document } = buildAnchors({
      transcript: transcript([segment(100, '那這筆進場我們就開始')]),
      category: trading,
    });
    expect(document.disagreements).toHaveLength(1);
    expect(document.disagreements[0]?.excerpt).toContain('這筆');
  });

  it('已經標記的位置不會重複提出', () => {
    const { document } = buildAnchors({
      transcript: transcript(
        [segment(100, '那這筆進場我們就開始')],
        [{ segmentIndex: 0, eventId: 'entry', quote: '那這筆進場' }],
      ),
      category: trading,
    });
    expect(document.disagreements).toHaveLength(0);
  });

  it('沒有前綴的標記不算不一致 —— 那正是放寬口令的目的', () => {
    const { document } = buildAnchors({
      transcript: transcript(
        [segment(100, '好我現在進場了')],
        [{ segmentIndex: 0, eventId: 'entry', quote: '我現在進場了' }],
      ),
      category: trading,
    });
    expect(document.disagreements).toHaveLength(0);
  });

  it('前綴的同音變體也會被交叉檢查抓到', () => {
    const { document } = buildAnchors({
      transcript: transcript([segment(100, '那這比進場我們就開始')]),
      category: trading,
    });
    expect(document.disagreements).toHaveLength(1);
  });
});
