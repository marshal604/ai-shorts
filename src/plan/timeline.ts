import type { Card, Cut } from '../types.ts';

/**
 * 把規劃器選出的素材區間換算成成品的時間軸。
 *
 * 核心規則：**文案長度決定片段長度，倍速由此推導**。
 * 使用者要的是「該講的講完、影片流暢」，不是湊秒數 —— 所以先算這張卡
 * 要看多久才讀得完，再回推畫面要放多快。骨架不規定倍速。
 */

/** 中文的舒適閱讀速度（字／秒）。偏保守 —— 讀不完比看太久糟得多。 */
const CHARS_PER_SECOND = 4.5;

/** 一張卡至少要停留多久，即使只有幾個字。 */
const MIN_CARD_SECONDS = 1.8;

/** 畫面最快能放多快。再快就看不出發生了什麼。 */
const MAX_SPEED = 8;

export function readingSeconds(text: string): number {
  return Math.max(MIN_CARD_SECONDS, text.length / CHARS_PER_SECOND);
}

export interface Selection {
  readonly positionId: string;
  /** 規劃器從取材窗口裡選出的長影片時間區間。 */
  readonly start: number;
  readonly end: number;
  readonly cardText: string;
  readonly cardKind: Card['kind'];
}

export interface Timeline {
  readonly cuts: readonly Cut[];
  readonly cards: readonly Card[];
  readonly durationSeconds: number;
}

/**
 * 一個片段在成品上要佔多久。
 *
 * 下界是把卡讀完的時間，上界是原速播放的長度 —— 不做慢動作。
 * 素材太長時最多壓到 MAX_SPEED，此時卡會停留得比閱讀時間久，那沒關係；
 * 反過來讓畫面追不上文字才是問題。
 */
function outputSeconds(sourceSpan: number, cardText: string): number {
  const needed = readingSeconds(cardText);
  const fastest = sourceSpan / MAX_SPEED;
  return Math.min(sourceSpan, Math.max(needed, fastest));
}

/** 把選材換算成片段與文案卡，並算出成品總長。 */
export function buildTimeline(selections: readonly Selection[]): Timeline {
  const cuts: Cut[] = [];
  const cards: Card[] = [];
  let elapsed = 0;

  for (const selection of selections) {
    const sourceSpan = selection.end - selection.start;
    if (sourceSpan <= 0) continue;

    const wanted = outputSeconds(sourceSpan, selection.cardText);
    const rawSpeed = sourceSpan / wanted;
    // 接近原速時不寫倍速欄位，但成品長度要用「實際會播多久」而不是想要多久 ——
    // 否則卡的時間會比片段短個百分之幾，逐段累積下來卡會愈跑愈前面。
    const usesSpeed = Math.abs(rawSpeed - 1) >= 0.02;
    const speed = usesSpeed ? Number(rawSpeed.toFixed(3)) : 1;
    const output = sourceSpan / speed;

    cuts.push({
      positionId: selection.positionId,
      start: selection.start,
      end: selection.end,
      ...(usesSpeed ? { speed } : {}),
    });

    if (selection.cardText.length > 0) {
      cards.push({
        kind: selection.cardKind,
        text: selection.cardText,
        start: Number(elapsed.toFixed(3)),
        end: Number((elapsed + output).toFixed(3)),
      });
    }
    elapsed += output;
  }

  return { cuts, cards, durationSeconds: Number(elapsed.toFixed(3)) };
}
