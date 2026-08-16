import * as OpenCC from 'opencc-js';
import type { Transcript } from '../types.ts';

/**
 * 比對前的正規化與全文組裝。
 *
 * 語音辨識會吐出簡體字、全形符號與大小寫不一的英文。實測三支樣本共 2154 字裡
 * 真正的簡體只有兩個，但兩個都剛好落在出場口令上 —— 低頻率、最大殺傷（ADR-0001）。
 */

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'twp' });

/** 全形英數與標點轉半形，讓 `ＴＰ１` 與 `TP1` 一致。 */
function toHalfWidth(text: string): string {
  return text
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

export function normalizeText(text: string): string {
  return toTraditional(toHalfWidth(text)).toUpperCase();
}

/**
 * 拼接後的全文，以及每個字元對應回長影片的時間。
 *
 * 所有比對都在全文上做再反查時間碼 —— 語音停頓會把同一句口令切成兩段，
 * 逐段比對會漏掉跨段的口令（ADR-0001）。
 */
export interface NormalizedTranscript {
  readonly text: string;
  /** 與 `text` 等長：第 i 個字元出現在長影片的第幾秒。 */
  readonly startAt: readonly number[];
  readonly endAt: readonly number[];
}

export function normalizeTranscript(transcript: Transcript): NormalizedTranscript {
  let text = '';
  const startAt: number[] = [];
  const endAt: number[] = [];

  for (const segment of transcript.segments) {
    // 逐段正規化：長度可能改變，所以時間對照要跟著段落一起建。
    const normalized = normalizeText(segment.text.trim());
    if (normalized.length === 0) continue;

    // 段內線性內插，不要把整段的字都對到段落起點 ——
    // 語音辨識偶爾會吐出數十秒的長段落，那樣錨點時間會差到半分鐘。
    const span = Math.max(0, segment.end - segment.start);
    for (let index = 0; index < normalized.length; index += 1) {
      startAt.push(segment.start + (span * index) / normalized.length);
      endAt.push(segment.start + (span * (index + 1)) / normalized.length);
    }
    text += normalized;
  }

  return { text, startAt, endAt };
}
