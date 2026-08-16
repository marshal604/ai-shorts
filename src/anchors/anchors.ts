import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Anchor, AnchorDocument, Category, CueEvent, Transcript } from '../types.ts';
import { PlanValidationError } from '../errors.ts';
import { buildSpans } from './spans.ts';

export interface BuildAnchorsOptions {
  readonly transcript: Transcript;
  readonly category: Category;
}

export interface AnchorsResult {
  readonly document: AnchorDocument;
}

/**
 * 標記所依據的原句在段落中的位置決定錨點時間。
 *
 * 直接取段落起點會失去段內精度：語音辨識偶爾吐出數十秒的長段落，
 * 而骨架的鉤子窗口只有三秒寬，差半分鐘就會剪到完全不相干的畫面。
 */
function anchorTime(segment: { start: number; end: number; text: string }, quote: string): number {
  if (quote.length === 0) return segment.start;
  const position = segment.text.indexOf(quote);
  if (position < 0 || segment.text.length === 0) return segment.start;
  const span = Math.max(0, segment.end - segment.start);
  return segment.start + (span * position) / segment.text.length;
}

function toAnchors(transcript: Transcript, byId: ReadonlyMap<string, CueEvent>): Anchor[] {
  return (transcript.events ?? [])
    .flatMap((marked) => {
      const event = byId.get(marked.eventId);
      const segment = transcript.segments[marked.segmentIndex];
      if (event === undefined || segment === undefined) return [];
      const anchor: Anchor = {
        at: anchorTime(segment, marked.quote),
        role: event.role,
        eventId: event.id,
        excerpt: marked.quote.length > 0 ? marked.quote : segment.text,
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      };
      return [anchor];
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * 逐字稿 → 錨點文件。
 *
 * 事件由來源準備階段標記（見 transcribe/correct.ts），這裡只負責配對成區段
 * 並算出取材窗口 —— 純函式，不做任何 I/O、不發任何請求。
 */
export function buildAnchors(options: BuildAnchorsOptions): AnchorsResult {
  // undefined 代表標記階段根本沒跑過（例如拿到未經準備的逐字稿），
  // 空陣列代表跑過但沒找到。兩者都會產出零個區段，但只有前者是錯誤 ——
  // 靜靜產出空文件正是 ADR-0001 禁止的無聲失敗。
  if (options.transcript.events === undefined) {
    throw new PlanValidationError(
      '逐字稿沒有事件標記。請先跑來源準備階段（transcribe），不要直接使用原始逐字稿。',
    );
  }

  const byId = new Map(options.category.vocabulary.events.map((event) => [event.id, event]));
  const anchors = toAnchors(options.transcript, byId);

  const { spans, unpaired } = buildSpans(
    anchors,
    options.category,
    options.transcript.source.durationSeconds,
  );
  return { document: { source: options.transcript.source, anchors, spans, unpaired } };
}

export async function writeAnchorDocument(document: AnchorDocument, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}
