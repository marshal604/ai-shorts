import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  Anchor,
  AnchorDocument,
  Category,
  CueEvent,
  Disagreement,
  Transcript,
} from '../types.ts';
import { detectCandidates } from './detect.ts';
import { normalizeTranscript } from './normalize.ts';
import { buildSpans } from './spans.ts';

export interface BuildAnchorsOptions {
  readonly transcript: Transcript;
  readonly category: Category;
}

export interface AnchorsResult {
  readonly document: AnchorDocument;
  readonly candidateCount: number;
}

/** 標記落在哪一段，就用那一段的起始時間當錨點時間。 */
function toAnchors(transcript: Transcript, byId: ReadonlyMap<string, CueEvent>): Anchor[] {
  return (transcript.events ?? [])
    .flatMap((marked) => {
      const event = byId.get(marked.eventId);
      const segment = transcript.segments[marked.segmentIndex];
      if (event === undefined || segment === undefined) return [];
      const anchor: Anchor = {
        at: segment.start,
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
 * 交叉檢查：前綴比對抓到、但標記階段沒有認定為事件的位置。
 *
 * 兩種訊號各有各的盲點 —— 標記靠語意（會把宣告讀成講解），比對靠字面
 * （會被同音字騙）。不一致時提出來讓使用者看，而不是任一方單獨決定。
 * 偵測層的錯是無聲的，唯一的解法是讓它現形（ADR-0001）。
 */
function findDisagreements(
  transcript: Transcript,
  category: Category,
  anchors: readonly Anchor[],
  toleranceSeconds: number,
): { readonly disagreements: Disagreement[]; readonly candidateCount: number } {
  const candidates = detectCandidates(normalizeTranscript(transcript), category.locator);
  const disagreements = candidates
    .filter((candidate) =>
      anchors.every((anchor) => Math.abs(anchor.at - candidate.at) > toleranceSeconds),
    )
    .map((candidate) => ({ at: candidate.at, excerpt: candidate.excerpt }));

  return { disagreements, candidateCount: candidates.length };
}

const DISAGREEMENT_TOLERANCE_SECONDS = 8;

/**
 * 逐字稿 → 錨點文件。
 *
 * 事件由來源準備階段標記（見 transcribe/correct.ts），這裡只負責配對成區段
 * 並算出取材窗口；字串比對退居交叉檢查。
 */
export function buildAnchors(options: BuildAnchorsOptions): AnchorsResult {
  const byId = new Map(options.category.locator.events.map((event) => [event.id, event]));
  const anchors = toAnchors(options.transcript, byId);

  const { spans, unpaired } = buildSpans(
    anchors,
    options.category,
    options.transcript.source.durationSeconds,
  );
  const { disagreements, candidateCount } = findDisagreements(
    options.transcript,
    options.category,
    anchors,
    DISAGREEMENT_TOLERANCE_SECONDS,
  );

  return {
    document: { source: options.transcript.source, anchors, spans, unpaired, disagreements },
    candidateCount,
  };
}

export async function writeAnchorDocument(document: AnchorDocument, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}
