import { ExternalToolError } from '../errors.ts';
import { ask, extractJson } from '../llm/client.ts';
import type { Category, MarkedEvent, Transcript, TranscriptSegment } from '../types.ts';

/**
 * 來源準備：一次讀完整份逐字稿，同時做兩件事 ——
 * 校正同音錯字與專有名詞，以及標記事件發生在哪一段。
 *
 * 為什麼合成一步：這一趟本來就要讀完整份逐字稿，讓它順便標記事件的
 * 邊際成本是零。原本把偵測交給字串比對的理由是「整份餵進模型太貴」，
 * 但既然校正已經在付這筆錢，那個理由就不成立了（ADR-0001）。
 *
 * 好處是講者不必逐字照喊固定口令 —— 說「現在進場」「我進了」都標得到。
 * 字串比對保留為交叉檢查：兩者不一致時提出來讓使用者看。
 *
 * 校正**逐段進行且不改變段落數與時間碼** —— 時間碼是後面所有定位的依據。
 */

const SYSTEM = [
  '你在處理交易分析影片的語音辨識逐字稿，同時做兩件事：校正錯字，以及標記事件。',
  '',
  '校正規則：',
  '1. 只改同音或近音造成的錯字，以及專有名詞。不要潤飾、不要刪語助詞、不要改語序。',
  '2. 段落數必須與輸入完全相同，一段對一段。沒有要改的段落原樣輸出。',
  '3. 不要合併或拆分段落。',
  '',
  '標記規則：',
  '4. 找出講者「宣告事件正在發生」的段落，不是講解、不是假設、不是回顧。',
  '5. 講者的說法不固定，同一個事件可能說成不同的話。依語意判斷，不要只看字面。',
  '6. 同一個事件被連著講兩次時，只標第一次。',
  '',
  '只輸出 JSON，不要任何其他文字。',
].join('\n');

function buildPrompt(segments: readonly TranscriptSegment[], category: Category): string {
  const corrections = Object.entries(category.glossary)
    .map(([wrong, right]) => `「${wrong}」應為「${right}」`)
    .join('；');

  const events = category.vocabulary.events
    .map((event) => `- ${event.id}：${event.description}`)
    .join('\n');

  // 每一批都從 0 編號。若沿用全域編號，模型在後續批次改回從 0 開始編號時
  // 所有查找都會落空 —— 校正靜靜失效、事件標記全被丟掉，而且沒有任何錯誤。
  const lines = segments.map((segment, index) => `${index}\t${segment.text}`).join('\n');

  return [
    `題材：${category.name}。`,
    corrections.length > 0 ? `已知的常見錯誤：${corrections}。` : '',
    '同音的口令用字也要修，例如「這筆」有時會被聽成「這比」「這畢」。',
    '',
    '要標記的事件種類：',
    events,
    '',
    `以下是逐字稿，每行是「編號<tab>內容」，共 ${segments.length} 段：`,
    lines,
    '',
    '輸出格式：',
    '{"segments":[{"i":<編號>,"t":"校正後的內容"}],',
    ' "events":[{"i":<編號>,"id":"<事件 id>","quote":"<依據的原句>"}]}',
    `segments 的長度必須是 ${segments.length}，events 沒有就給空陣列。`,
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

interface Parsed {
  readonly segments: TranscriptSegment[];
  readonly events: MarkedEvent[];
}

function parseBatch(
  batch: readonly TranscriptSegment[],
  offset: number,
  raw: unknown,
  validEventIds: ReadonlySet<string>,
): Parsed {
  if (typeof raw !== 'object' || raw === null) {
    throw new ExternalToolError('anthropic', null, '來源準備結果不是物件');
  }
  const record = raw as Record<string, unknown>;

  const textByIndex = new Map<number, string>();
  for (const entry of Array.isArray(record['segments']) ? record['segments'] : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item['i'] === 'number' && typeof item['t'] === 'string' && item['t'].trim().length > 0) {
      textByIndex.set(item['i'], item['t'].trim());
    }
  }

  const events: MarkedEvent[] = [];
  for (const entry of Array.isArray(record['events']) ? record['events'] : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const index = item['i'];
    const id = item['id'];
    if (typeof index !== 'number' || typeof id !== 'string' || !validEventIds.has(id)) continue;
    if (index < 0 || index >= batch.length) continue;
    events.push({
      segmentIndex: offset + index,
      eventId: id,
      quote: typeof item['quote'] === 'string' ? item['quote'] : '',
    });
  }

  // 完全沒有一個編號落在範圍內，代表模型用了我們沒預期的編號方式。
  // 這種情況若默默沿用原文，校正與標記會整批失效而沒有任何跡象。
  const inRange = [...textByIndex.keys()].filter((key) => key >= 0 && key < batch.length);
  if (textByIndex.size > 0 && inRange.length === 0) {
    throw new ExternalToolError(
      'anthropic',
      null,
      `這一批的段落編號全部超出範圍（預期 0–${batch.length - 1}），無法對應回原段落`,
    );
  }

  // 時間碼一律沿用原段落 —— 準備階段只准動文字與標記。
  return {
    segments: batch.map((segment, index) => ({
      ...segment,
      text: textByIndex.get(index) ?? segment.text,
    })),
    events,
  };
}

export interface CorrectOptions {
  readonly transcript: Transcript;
  readonly category: Category;
  readonly cacheDir: string;
  /** 一次送多少段。段落太多時分批，避免單次回應被截斷。 */
  readonly batchSize?: number;
}

export interface CorrectionResult {
  readonly transcript: Transcript;
  readonly changedSegments: number;
  readonly markedEvents: number;
}

export async function prepareTranscript(options: CorrectOptions): Promise<CorrectionResult> {
  const size = options.batchSize ?? 120;
  const original = options.transcript.segments;
  const validEventIds = new Set(options.category.vocabulary.events.map((event) => event.id));

  const segments: TranscriptSegment[] = [];
  const events: MarkedEvent[] = [];

  for (let offset = 0; offset < original.length; offset += size) {
    const batch = original.slice(offset, offset + size);
    const { text } = await ask({
      system: SYSTEM,
      prompt: buildPrompt(batch, options.category),
      maxTokens: 8192,
      cacheDir: options.cacheDir,
    });
    const parsed = parseBatch(batch, offset, extractJson(text), validEventIds);
    segments.push(...parsed.segments);
    events.push(...parsed.events);
  }

  const changedSegments = segments.filter(
    (segment, index) => segment.text !== original[index]?.text,
  ).length;

  return {
    transcript: { ...options.transcript, segments, events },
    changedSegments,
    markedEvents: events.length,
  };
}
