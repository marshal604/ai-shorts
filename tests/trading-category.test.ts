import { describe, expect, it } from 'vitest';
import { trading } from '../src/categories/trading.ts';
import type { AnchorRole } from '../src/types.ts';

const eventsWithRole = (role: AnchorRole) =>
  trading.vocabulary.events.filter((event) => event.role === role);

describe('交易類別', () => {
  it('事件詞彙表不為空 —— 沒有事件就沒有東西可標記', () => {
    expect(trading.vocabulary.events.length).toBeGreaterThan(0);
  });

  it('恰有一種開啟事件', () => {
    expect(eventsWithRole('open')).toHaveLength(1);
  });

  it('每一種結束事件都帶結果標籤', () => {
    const closers = eventsWithRole('close');
    expect(closers.length).toBeGreaterThan(0);
    for (const event of closers) {
      expect(event.outcome).toBeTruthy();
    }
  });

  it('開啟事件不帶結果標籤 —— 結果是結束時才知道的事', () => {
    for (const event of eventsWithRole('open')) {
      expect(event.outcome).toBeUndefined();
    }
  });

  it('每個事件都有給分類器讀的描述，而不是靠字串比對', () => {
    for (const event of trading.vocabulary.events) {
      expect(event.description.length).toBeGreaterThan(4);
    }
  });

  it('事件 id 不重複', () => {
    const ids = trading.vocabulary.events.map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('骨架至少有一個不可塌縮的位置 —— 否則骨架可能整個消失', () => {
    expect(trading.skeleton.some((position) => !position.collapsible)).toBe(true);
  });

  it('骨架位置的窗口都是正長度', () => {
    for (const position of trading.skeleton) {
      expect(position.source.to).toBeGreaterThan(position.source.from);
    }
  });

  it('骨架位置 id 不重複', () => {
    const ids = trading.skeleton.map((position) => position.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('骨架的原始素材總長落在目標長度的合理倍數內', () => {
    const raw = trading.skeleton.reduce((total, position) => {
      const span = position.source.to - position.source.from;
      return total + span / (position.speed ?? 1);
    }, 0);
    expect(raw).toBeGreaterThanOrEqual(trading.duration.min);
    expect(raw).toBeLessThanOrEqual(trading.duration.max);
  });

  it('長度目標的上下界包住目標值', () => {
    expect(trading.duration.min).toBeLessThanOrEqual(trading.duration.target);
    expect(trading.duration.target).toBeLessThanOrEqual(trading.duration.max);
  });

  it('預設指向 YouTube 音樂庫的曲目，檔案不存在時會降級', () => {
    expect(trading.music.path).toMatch(/assets\/music\/.+\.m4a$/);
  });

  it('每個骨架位置都說明了它的文案要講什麼 —— 沒有人聲，卡就是敘事', () => {
    for (const position of trading.skeleton) {
      expect(position.cardBrief.length).toBeGreaterThan(8);
    }
  });

  it('音樂音量壓在底噪，不搶畫面', () => {
    expect(trading.music.gainDb).toBeLessThan(-10);
  });

  it('音樂有淡入與淡出', () => {
    expect(trading.music.fadeInSeconds).toBeGreaterThan(0);
    expect(trading.music.fadeOutSeconds).toBeGreaterThan(0);
  });

  it('術語表涵蓋實測過的語音辨識誤轉', () => {
    expect(trading.glossary['FBG']).toBe('FVG');
    expect(trading.glossary['只贏']).toBe('止盈');
    expect(trading.glossary['止存']).toBe('止損');
  });
});
