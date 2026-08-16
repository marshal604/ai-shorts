import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildFfmpegArgs, cutDuration, planDuration } from '../src/render/filtergraph.ts';
import { outputBasename, validatePlan } from '../src/render/render.ts';
import { PlanValidationError } from '../src/errors.ts';
import type { Plan } from '../src/types.ts';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/plan-s3-trade1.json', import.meta.url)), 'utf8'),
) as Plan;

const filterOf = (plan: Plan): string => {
  const args = buildFfmpegArgs(plan, '/tmp/out.mp4');
  const index = args.indexOf('-filter_complex');
  return args[index + 1] ?? '';
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
    expect(total).toBeGreaterThanOrEqual(45);
    expect(total).toBeLessThanOrEqual(60);
  });
});

describe('ffmpeg 參數', () => {
  it('每個片段各開一次輸入並快速定位，不從頭解碼', () => {
    const args = buildFfmpegArgs(fixture, '/tmp/out.mp4');
    const inputs = args.filter((arg) => arg === '-i');
    const seeks = args.filter((arg) => arg === '-ss');
    expect(inputs).toHaveLength(fixture.cuts.length);
    expect(seeks).toHaveLength(fixture.cuts.length);
  });

  it('把所有片段接成單一影音串流', () => {
    expect(filterOf(fixture)).toContain(`concat=n=${fixture.cuts.length}:v=1:a=1`);
  });

  it('靜音片段生成等長無聲軌，而不是沿用原聲', () => {
    const filter = filterOf(fixture);
    const muteCount = fixture.cuts.filter((cut) => cut.audio === 'mute').length;
    expect(filter.split('anullsrc').length - 1).toBe(muteCount);
    expect(filter).toContain('atrim=duration=1.250');
  });

  it('快轉片段以除法壓縮時間戳', () => {
    expect(filterOf(fixture)).toContain('setpts=(PTS-STARTPTS)/8');
  });

  it('原速片段不做時間戳除法', () => {
    expect(filterOf(fixture)).toContain('setpts=PTS-STARTPTS');
  });

  it('每個片段都補滿成 1080x1920 直式畫布', () => {
    const filter = filterOf(fixture);
    expect(filter.split('pad=1080:1920').length - 1).toBe(fixture.cuts.length);
  });

  it('輸出為相容於平台的 H.264 加 AAC', () => {
    const args = buildFfmpegArgs(fixture, '/tmp/out.mp4');
    expect(args).toContain('libx264');
    expect(args).toContain('aac');
    expect(args).toContain('yuv420p');
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
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
      cuts: [{ positionId: 'x', start: 10, end: 5, framing: 'roi', audio: 'original' }],
    };
    expect(() => validatePlan(broken)).toThrow(PlanValidationError);
  });

  it('拒絕非正數的倍速', () => {
    const broken: Plan = {
      ...fixture,
      cuts: [{ positionId: 'x', start: 1, end: 5, framing: 'roi', audio: 'mute', speed: 0 }],
    };
    expect(() => validatePlan(broken)).toThrow(PlanValidationError);
  });

  it('錯誤訊息列出所有問題，不是只報第一個', () => {
    const broken: Plan = {
      ...fixture,
      source: { ...fixture.source, width: 0 },
      cuts: [{ positionId: 'x', start: -1, end: -5, framing: 'roi', audio: 'original' }],
    };
    expect(() => validatePlan(broken)).toThrow(/source\.width[\s\S]*start[\s\S]*end/);
  });
});

describe('計畫驗證：手改壞的檔案', () => {
  it('變速片段搭配原聲會被拒絕 —— 聲音不會跟著變速，成品會被拉長到音軌長度', () => {
    const broken: Plan = {
      ...fixture,
      cuts: [{ positionId: 'holding', start: 0, end: 8, framing: 'full', audio: 'original', speed: 4 }],
    };
    expect(() => validatePlan(broken)).toThrow(/變速片段必須靜音/);
  });

  it('原速片段搭配原聲當然可以', () => {
    const fine: Plan = {
      ...fixture,
      cuts: [{ positionId: 'reveal', start: 0, end: 8, framing: 'roi', audio: 'original', speed: 1 }],
    };
    expect(() => validatePlan(fine)).not.toThrow();
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

  it('片段的構圖與音訊只接受合法值', () => {
    const broken: Plan = {
      ...fixture,
      cuts: [
        { positionId: 'x', start: 0, end: 5, framing: 'zoom' as never, audio: 'loud' as never },
      ],
    };
    expect(() => validatePlan(broken)).toThrow(/framing[\s\S]*audio/);
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
