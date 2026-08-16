import { ExternalToolError } from '../errors.ts';
import { ask, extractJson } from '../llm/client.ts';
import type { Category, Transcript, TranscriptSegment } from '../types.ts';

/**
 * 轉錄後的校正：把語音辨識的同音錯字改回領域裡正確的寫法。
 *
 * 這一步存在的理由是「先把逐字稿變正確，再走下一步」——
 * 否則每個下游環節（偵測、分類、文案）都要各自容錯，而且各錯各的。
 *
 * 為什麼不用 whisper 的 initial prompt 做這件事：實測它會連帶改變斷句、
 * 吞掉音訊、把錨點前綴改成同音錯字，得不償失（見 transcribe.ts 的註解）。
 *
 * 校正**逐段進行且不改變段落數與時間碼** —— 時間碼是後面所有定位的依據，
 * 不容許在這一步漂移。
 */

const SYSTEM = [
  '你在校正交易分析影片的語音辨識逐字稿。逐字稿有大量同音錯字與專有名詞錯誤。',
  '你的工作只有一件：把明顯錯的字改成正確的寫法。',
  '',
  '規則：',
  '1. 只改同音或近音造成的錯字，以及專有名詞。不要潤飾、不要刪語助詞、不要改語序。',
  '2. 段落數必須與輸入完全相同，一段對一段。沒有要改的段落原樣輸出。',
  '3. 不要合併或拆分段落。',
  '4. 只輸出 JSON，不要任何其他文字。',
].join('\n');

function buildPrompt(segments: readonly TranscriptSegment[], category: Category): string {
  const corrections = Object.entries(category.glossary)
    .map(([wrong, right]) => `「${wrong}」應為「${right}」`)
    .join('；');

  const lines = segments.map((segment, index) => `${index}\t${segment.text}`).join('\n');

  return [
    `題材：${category.name}。`,
    corrections.length > 0 ? `已知的常見錯誤：${corrections}。` : '',
    '也請留意同音的口令用字，例如「這筆」有時會被聽成「這比」「這畢」。',
    '',
    `以下是 ${segments.length} 段逐字稿，每行是「編號<tab>內容」：`,
    lines,
    '',
    `輸出格式（陣列，長度必須是 ${segments.length}）：`,
    '[{"i":0,"t":"校正後的內容"},{"i":1,"t":"校正後的內容"}]',
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

function applyCorrections(
  segments: readonly TranscriptSegment[],
  raw: unknown,
): TranscriptSegment[] {
  if (!Array.isArray(raw)) {
    throw new ExternalToolError('anthropic', null, '校正結果不是陣列');
  }

  const byIndex = new Map<number, string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const index = record['i'];
    const text = record['t'];
    if (typeof index === 'number' && typeof text === 'string' && text.trim().length > 0) {
      byIndex.set(index, text.trim());
    }
  }

  // 時間碼一律沿用原段落 —— 校正只准動文字。
  return segments.map((segment, index) => ({
    ...segment,
    text: byIndex.get(index) ?? segment.text,
  }));
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
}

export async function correctTranscript(options: CorrectOptions): Promise<CorrectionResult> {
  const size = options.batchSize ?? 120;
  const segments = options.transcript.segments;
  const corrected: TranscriptSegment[] = [];

  for (let offset = 0; offset < segments.length; offset += size) {
    const batch = segments.slice(offset, offset + size);
    const { text } = await ask({
      system: SYSTEM,
      prompt: buildPrompt(batch, options.category),
      maxTokens: 8192,
      cacheDir: options.cacheDir,
    });
    corrected.push(...applyCorrections(batch, extractJson(text)));
  }

  const changedSegments = corrected.filter(
    (segment, index) => segment.text !== segments[index]?.text,
  ).length;

  return {
    transcript: { ...options.transcript, segments: corrected },
    changedSegments,
  };
}
