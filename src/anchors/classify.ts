import { ExternalToolError } from '../errors.ts';
import { ask, extractJson } from '../llm/client.ts';
import type { Anchor, CueLocator } from '../types.ts';
import type { Candidate } from './detect.ts';

/**
 * 把前綴候選分類成錨點，或判定它不是。
 *
 * 不維護語音辨識變體的白名單：變體是情境相關的（同一位講者說「那這筆就是止盈」
 * 時全對，說「TP1只贏了」時全錯），人工白名單追不上也無法窮舉。改由模型讀
 * 事件的自然語言描述來吸收變體（ADR-0001）。
 *
 * 一支影片一次批次呼叫，不是每個候選各一次。
 */

const SYSTEM = [
  '你在判讀交易分析影片的逐字稿。講者會在錄影當下口頭標記事件，但也會在講解時說出同樣的詞。',
  '你的工作是分辨哪些是真的事件宣告，哪些只是講解，並指出它屬於哪一種事件。',
  '逐字稿由語音辨識產生，專有名詞與同音詞經常出錯（例如「止盈」可能變成「只贏」或「止音」，',
  '「止損」可能變成「止存」）。請依語意判斷，不要因為字面不同就判定不是事件。',
  '只輸出 JSON，不要任何其他文字。',
].join('\n');

interface Decision {
  readonly index: number;
  readonly isAnchor: boolean;
  readonly eventId: string | null;
}

function buildPrompt(candidates: readonly Candidate[], locator: CueLocator): string {
  const events = locator.events
    .map((event) => `- ${event.id}（${event.role === 'open' ? '開始' : '結束'}）：${event.description}`)
    .join('\n');

  const list = candidates
    .map((candidate, index) => `${index}. 「${candidate.context}」`)
    .join('\n');

  return [
    '事件種類：',
    events,
    '',
    '以下每一則都是逐字稿中出現關鍵前綴的位置，附上前後文。',
    '請判斷每一則是不是講者在宣告事件，如果是，屬於哪一種。',
    '',
    list,
    '',
    '輸出格式（陣列，每個候選一筆，index 對應上面的編號）：',
    '[{"index":0,"isAnchor":true,"eventId":"<事件 id>"},{"index":1,"isAnchor":false,"eventId":null}]',
  ].join('\n');
}

function parseDecisions(raw: unknown, total: number): Decision[] {
  if (!Array.isArray(raw)) {
    throw new ExternalToolError('anthropic', null, '分類結果不是陣列');
  }
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      index: typeof entry['index'] === 'number' ? entry['index'] : -1,
      isAnchor: entry['isAnchor'] === true,
      eventId: typeof entry['eventId'] === 'string' ? entry['eventId'] : null,
    }))
    .filter((decision) => decision.index >= 0 && decision.index < total);
}

export interface ClassifyOptions {
  readonly cacheDir: string;
}

export async function classifyCandidates(
  candidates: readonly Candidate[],
  locator: CueLocator,
  options: ClassifyOptions,
): Promise<Anchor[]> {
  if (candidates.length === 0) return [];

  const { text } = await ask({
    system: SYSTEM,
    prompt: buildPrompt(candidates, locator),
    maxTokens: 2048,
    cacheDir: options.cacheDir,
  });

  const decisions = parseDecisions(extractJson(text), candidates.length);
  const byId = new Map(locator.events.map((event) => [event.id, event]));

  return decisions
    .filter((decision) => decision.isAnchor && decision.eventId !== null)
    .flatMap((decision) => {
      const event = byId.get(decision.eventId as string);
      const candidate = candidates[decision.index];
      if (event === undefined || candidate === undefined) return [];
      const anchor: Anchor = {
        at: candidate.at,
        role: event.role,
        eventId: event.id,
        excerpt: candidate.excerpt,
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
      };
      return [anchor];
    })
    .sort((a, b) => a.at - b.at);
}
