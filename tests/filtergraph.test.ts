import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, cutDuration, planDuration } from '../src/render/filtergraph.ts';
import { DEFAULT_MUSIC } from '../src/render/music.ts';
import { outputBasename, readableTimecode, validatePlan } from '../src/render/render.ts';
import { PlanValidationError } from '../src/errors.ts';
import type { MusicConfig, Plan } from '../src/types.ts';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/plan-s3-trade1.json', import.meta.url)), 'utf8'),
) as Plan;

const cardPaths = (plan: Plan) => plan.cards.map((_, index) => `/tmp/card-${index}.png`);

const argsOf = (plan: Plan, music: MusicConfig = DEFAULT_MUSIC): string[] =>
  buildFfmpegArgs(plan, {
    outputPath: '/tmp/out.mp4',
    cardImagePaths: cardPaths(plan),
    music,
  });

const filterOf = (plan: Plan, music: MusicConfig = DEFAULT_MUSIC): string => {
  const args = argsOf(plan, music);
  return args[args.indexOf('-filter_complex') + 1] ?? '';
};

describe('片段長度', () => {
  it('快轉會縮短成品長度', () => {
    const holding = fixture.cuts.find((cut) => cut.positionId === 'holding');
    expect(holding).toBeDefined();
    expect(cutDuration(holding!)).toBeCloseTo(10 / 8, 5);
  });

  it('原速片段的成品長度等於來源長度', () => {
    const reveal = fixture.cuts.find((cut) => cut.positionId === 'reveal');
    expect(cutDuration(reveal!)).toBeCloseTo(10, 5);
  });

  it('計畫總長落在交易類別的目標範圍內', () => {
    const total = planDuration(fixture);
    expect(total).toBeGreaterThanOrEqual(25);
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe('影像組裝', () => {
  it('每個片段各開一次輸入並快速定位，不從頭解碼', () => {
    const args = argsOf(fixture);
    expect(args.filter((arg) => arg === '-ss')).toHaveLength(fixture.cuts.length);
  });

  it('把所有片段接成單一影像串流，不再拼接音訊', () => {
    expect(filterOf(fixture)).toContain(`concat=n=${fixture.cuts.length}:v=1:a=0`);
  });

  it('任何片段都能變速 —— 原聲已丟棄，沒有變調問題', () => {
    const filter = filterOf(fixture);
    expect(filter).toContain('setpts=(PTS-STARTPTS)/8');
    expect(filter).toContain('setpts=(PTS-STARTPTS)/2.5');
  });

  it('每個片段都補滿成 1080x1920 直式畫布', () => {
    expect(filterOf(fixture).split('pad=1080:1920').length - 1).toBe(fixture.cuts.length);
  });
});

describe('背景音樂', () => {
  it('成品完全不使用長影片的原聲', () => {
    const filter = filterOf(fixture);
    expect(filter).not.toContain(':a]asetpts');
    expect(filter).not.toContain('amerge');
  });

  it('未指定音樂檔時使用程式生成的底樂，不需要額外輸入', () => {
    const args = argsOf(fixture);
    expect(args.filter((arg) => arg === '-i')).toHaveLength(
      fixture.cuts.length + fixture.cards.length,
    );
    expect(filterOf(fixture)).toContain('sine=frequency=');
  });

  it('指定音樂檔時循環輸入並裁到成品長度', () => {
    const withFile: MusicConfig = { ...DEFAULT_MUSIC, path: '/tmp/bed.mp3' };
    const args = argsOf(fixture, withFile);
    expect(args).toContain('-stream_loop');
    expect(args).toContain('/tmp/bed.mp3');
    expect(filterOf(fixture, withFile)).toContain(
      `atrim=duration=${planDuration(fixture).toFixed(3)}`,
    );
  });

  it('音量與淡入淡出來自設定', () => {
    const custom: MusicConfig = { gainDb: -12, fadeInSeconds: 0.5, fadeOutSeconds: 1 };
    const filter = filterOf(fixture, custom);
    expect(filter).toContain('volume=-12dB');
    expect(filter).toContain('afade=t=in:st=0:d=0.500');
    expect(filter).toContain('afade=t=out:');
  });

  it('音軌的每一段濾鏡都不是空的 —— 空濾鏡會讓整張圖被拒絕', () => {
    for (const music of [DEFAULT_MUSIC, { ...DEFAULT_MUSIC, path: '/tmp/bed.mp3' }]) {
      for (const segment of filterOf(fixture, music).split(';')) {
        for (const step of segment.split(',')) {
          expect(step.trim()).not.toBe('');
        }
      }
    }
  });

  it('淡出不會早於片頭 —— 極短的片子也要能渲染', () => {
    const tiny: Plan = {
      ...fixture,
      cuts: [{ positionId: 'only', start: 0, end: 1, framing: 'roi' }],
      cards: [],
    };
    const filter = filterOf(tiny, { gainDb: -20, fadeInSeconds: 5, fadeOutSeconds: 5 });
    expect(filter).toContain('afade=t=out:st=0.000');
  });
});

describe('文案卡圖層', () => {
  it('每張卡各佔一個輸入並疊在影像之上', () => {
    const filter = filterOf(fixture);
    expect(filter.split(':v]format=rgba').length - 1).toBe(fixture.cards.length);
    expect(filter.split('overlay=0:0:').length - 1).toBe(fixture.cards.length);
  });

  it('每張卡只在自己的時間區間內顯示', () => {
    const filter = filterOf(fixture);
    for (const card of fixture.cards) {
      expect(filter).toContain(
        `enable='between(t,${card.start.toFixed(3)},${card.end.toFixed(3)})'`,
      );
    }
  });

  it('沒有文案卡時仍然渲染得出影片', () => {
    const bare: Plan = { ...fixture, cards: [] };
    const filter = filterOf(bare);
    expect(filter).not.toContain('overlay');
    expect(filter).toContain('[vbase]format=yuv420p[outv]');
  });
});

describe('計畫驗證', () => {
  it('接受手寫的合法計畫', () => {
    expect(() => validatePlan(fixture)).not.toThrow();
  });

  it('拒絕片段為空的計畫', () => {
    expect(() => validatePlan({ ...fixture, cuts: [] })).toThrow(PlanValidationError);
  });

  it('拒絕結束早於開始的片段', () => {
    const broken: Plan = {
      ...fixture,
      cuts: [{ positionId: 'x', start: 10, end: 5, framing: 'roi' }],
    };
    expect(() => validatePlan(broken)).toThrow(PlanValidationError);
  });

  it('拒絕非正數的倍速', () => {
    const broken: Plan = {
      ...fixture,
      cuts: [{ positionId: 'x', start: 1, end: 5, framing: 'roi', speed: 0 }],
    };
    expect(() => validatePlan(broken)).toThrow(/speed/);
  });

  it('拒絕落在片尾之後的文案卡 —— 那張卡永遠不會出現', () => {
    const broken: Plan = {
      ...fixture,
      cards: [{ kind: 'caption', text: '看不到我', start: 999, end: 1000 }],
    };
    expect(() => validatePlan(broken)).toThrow(/不會出現/);
  });

  it('拒絕沒有文字的文案卡', () => {
    const broken: Plan = {
      ...fixture,
      cards: [{ kind: 'caption', text: '', start: 0, end: 2 }],
    };
    expect(() => validatePlan(broken)).toThrow(/text/);
  });

  it('接受完全沒有文案卡的計畫', () => {
    expect(() => validatePlan({ ...fixture, cards: [] })).not.toThrow();
  });

  it('缺少 cards 時驗證失敗 —— 下游一律直接取用，缺席會炸成 TypeError', () => {
    const broken: Record<string, unknown> = { ...fixture };
    delete broken['cards'];
    expect(() => validatePlan(broken)).toThrow(PlanValidationError);
  });

  it('拒絕同類且時間重疊的文案卡 —— 會疊在同一塊區域上', () => {
    const broken: Plan = {
      ...fixture,
      cards: [
        { kind: 'title', text: '第一張', start: 0, end: 5 },
        { kind: 'title', text: '第二張', start: 3, end: 8 },
      ],
    };
    expect(() => validatePlan(broken)).toThrow(/重疊/);
  });

  it('不同類的卡可以時間重疊 —— 它們在不同的帶狀區', () => {
    const fine: Plan = {
      ...fixture,
      cards: [
        { kind: 'title', text: '標題', start: 0, end: 5 },
        { kind: 'caption', text: '字幕', start: 0, end: 5 },
      ],
    };
    expect(() => validatePlan(fine)).not.toThrow();
  });

  it('拒絕超過字數上限的文案卡 —— 超出的部分會被靜靜截掉', () => {
    const broken: Plan = {
      ...fixture,
      cards: [{ kind: 'title', text: '這段文字非常非常長長到根本放不進標題帶裡面去所以一定會被靜靜截掉一半', start: 0, end: 5 }],
    };
    expect(() => validatePlan(broken)).toThrow(/上限/);
  });

  it('拒絕沒有 positionId 的片段 —— metadata 會印出 undefined', () => {
    const broken: Plan = {
      ...fixture,
      cuts: [{ start: 0, end: 5, framing: 'roi' } as never],
    };
    expect(() => validatePlan(broken)).toThrow(/positionId/);
  });

  it('拒絕負數或小數的區段序號 —— 它會直接進檔名', () => {
    for (const index of [-1, 1.5]) {
      const broken: Plan = { ...fixture, span: { ...fixture.span, index } };
      expect(() => validatePlan(broken)).toThrow(/span\.index/);
    }
  });

  for (const missing of ['span', 'cuts', 'source', 'metadata'] as const) {
    it(`缺少 ${missing} 時給出看得懂的錯誤，而不是 TypeError`, () => {
      const broken: Record<string, unknown> = { ...fixture };
      delete broken[missing];
      expect(() => validatePlan(broken)).toThrow(PlanValidationError);
    });
  }

  it('最外層不是物件時也不會炸成 TypeError', () => {
    expect(() => validatePlan(null)).toThrow(PlanValidationError);
    expect(() => validatePlan('計畫')).toThrow(PlanValidationError);
  });

  it('錯誤訊息列出所有問題，不是只報第一個', () => {
    const broken: Plan = {
      ...fixture,
      source: { ...fixture.source, width: 0 },
      cuts: [{ positionId: 'x', start: -1, end: -5, framing: 'roi' }],
    };
    expect(() => validatePlan(broken)).toThrow(/source\.width[\s\S]*start[\s\S]*end/);
  });
});

describe('時間碼', () => {
  it('一般長度正確', () => {
    expect(readableTimecode(0)).toBe('00:00');
    expect(readableTimecode(515.4)).toBe('08:35');
  });

  it('超過 99 分鐘不會錯位 —— 一整場交易的錄影會超過', () => {
    expect(readableTimecode(6000)).toBe('100:00');
    expect(readableTimecode(7325)).toBe('122:05');
  });
});

describe('輸出命名', () => {
  it('檔名帶序號、起始時間碼與結果', () => {
    expect(outputBasename(fixture)).toBe('01-0835-止損');
  });

  it('結果裡的路徑分隔符被清掉 —— 否則整段編碼跑完才會失敗，或寫到目錄外', () => {
    const escaping: Plan = { ...fixture, span: { ...fixture.span, outcome: '../escaped' } };
    const basename = outputBasename(escaping);
    expect(basename).not.toContain('/');
    expect(basename).not.toContain('..');
  });

  it('結果裡的空白與其他不安全字元也被清掉', () => {
    const messy: Plan = { ...fixture, span: { ...fixture.span, outcome: '止盈 : 部分*' } };
    expect(outputBasename(messy)).toBe('01-0835-止盈___部分_');
  });
});
