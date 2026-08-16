import type { CueLocator } from '../types.ts';
import { normalizeText } from './normalize.ts';
import type { NormalizedTranscript } from './normalize.ts';

/**
 * 前綴出現的一次候選。偵測完全靠字串比對，決定性且召回導向；
 * 判斷它是不是真的錨點、屬於哪一種事件，是分類器的事（ADR-0001）。
 */
export interface Candidate {
  readonly at: number;
  /** 前綴之後的一小段原文，交給分類器判讀。 */
  readonly excerpt: string;
  /** 前後文較寬，讓分類器能分辨講解與宣告。 */
  readonly context: string;
}

const CONTEXT_BEFORE = 30;

/**
 * 找出前綴在全文中的每一次出現。
 *
 * 前綴在 231,715 段同題材語料中僅出現 1 次，在自錄樣本中召回率 100%、
 * 精確率約 67%（誤報如「這筆方向就做錯了」）—— 誤報由分類器濾掉，
 * 漏偵測則無從察覺，所以這裡寧可多抓。
 */
export function detectCandidates(
  transcript: NormalizedTranscript,
  locator: CueLocator,
): Candidate[] {
  const prefixes = locator.prefixes.map(normalizeText).filter((prefix) => prefix.length > 0);
  const found = new Map<number, Candidate>();

  for (const prefix of prefixes) {
    let index = transcript.text.indexOf(prefix);
    while (index >= 0) {
      const at = transcript.startAt[index];
      if (at !== undefined && !found.has(index)) {
        found.set(index, {
          at,
          excerpt: transcript.text.slice(index, index + prefix.length + locator.proximity),
          context: transcript.text.slice(
            Math.max(0, index - CONTEXT_BEFORE),
            index + prefix.length + locator.proximity,
          ),
        });
      }
      index = transcript.text.indexOf(prefix, index + prefix.length);
    }
  }

  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, candidate]) => candidate);
}
