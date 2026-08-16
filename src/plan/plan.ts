import { ExternalToolError } from '../errors.ts';
import { ask, extractJson } from '../llm/client.ts';
import type { Card, Category, Plan, Position, Span, Transcript } from '../types.ts';
import { buildTimeline, readingSeconds } from './timeline.ts';
import type { Selection } from './timeline.ts';

/**
 * 區段 → 計畫。
 *
 * 規劃器在取材窗口裡**依內容**選出每個骨架位置要用的時間區間，而不是套用
 * 固定位移。固定位移會盲目抓走「錨點前 N 秒」不管那裡在講什麼：實測抓到的
 * 是一個沒有發生的做多想法，而該筆交易是做空 —— 文案卡就會寫錯方向。
 *
 * 文案是**濃縮改寫**而非逐字轉寫，但只能根據窗口內實際說過的話與已知的
 * 交易事實。編造聽起來合理的句子是本專案最危險的失敗模式，因為它讀起來
 * 很順，沒有人會發現。
 */

const SYSTEM = [
  '你在把一段交易分析影片的逐字稿，規劃成一支沒有人聲的直式短影片。',
  '短影片的敘事完全由畫面上的文字卡承載，觀眾聽不到講者說話。',
  '',
  '規則：',
  '1. 每個位置從提供的逐字稿裡挑一段連續時間，挑「這段內容真的在講該位置要講的事」的那一段。',
  '2. 找不到合適素材的位置就略過，寧可缺一段也不要硬湊不相干的內容。',
  '3. 文案是濃縮改寫，不是逐字轉寫。刪掉語助詞與重複，保留判斷與數字。',
  '4. **只能寫逐字稿裡說過、或交易事實裡已知的內容。** 不確定的事寧可不寫。',
  '   尤其是方向（做多／做空）、停損位置、風報比 —— 寫錯比不寫嚴重得多。',
  '5. 選出的時間區間必須落在該位置允許的範圍內，且不可互相重疊。',
  '6. 只輸出 JSON，不要任何其他文字。',
].join('\n');

interface WindowBounds {
  readonly from: number;
  readonly to: number;
}

/** 一個位置實際能取材的範圍：骨架的上界與區段取材窗口的交集。 */
export function positionBounds(position: Position, span: Span): WindowBounds {
  const anchorAt = position.source.anchor === 'open' ? span.openAt : span.closeAt;
  const { direction, reach } = position.source;

  const rawFrom = direction === 'after' ? anchorAt : anchorAt - reach;
  const rawTo = direction === 'before' ? anchorAt : anchorAt + reach;

  const windowFrom = Math.min(span.window.openFrom, span.window.closeFrom);
  const windowTo = Math.max(span.window.openTo, span.window.closeTo);

  return {
    from: Math.max(rawFrom, windowFrom),
    to: Math.min(rawTo, windowTo),
  };
}

function transcriptSlice(transcript: Transcript, bounds: WindowBounds): string {
  return transcript.segments
    .filter((segment) => segment.end > bounds.from && segment.start < bounds.to)
    .map((segment) => `[${segment.start.toFixed(1)}] ${segment.text}`)
    .join('\n');
}

function buildPrompt(span: Span, category: Category, transcript: Transcript): string {
  const positions = category.skeleton.map((position) => {
    const bounds = positionBounds(position, span);
    return [
      `### ${position.id}${position.collapsible ? '（可略過）' : '（必須有）'}`,
      `要傳達：${position.cardBrief}`,
      `可取材範圍：${bounds.from.toFixed(1)} 到 ${bounds.to.toFixed(1)} 秒`,
      '該範圍的逐字稿：',
      transcriptSlice(transcript, bounds) || '（這個範圍沒有內容）',
    ].join('\n');
  });

  return [
    `這筆交易的結果是「${span.outcome}」，從 ${span.openAt.toFixed(1)} 秒進場、${span.closeAt.toFixed(1)} 秒結束。`,
    `短影片的目標長度約 ${category.duration.target} 秒，但以把內容講完、節奏流暢為準，不必硬湊。`,
    '',
    '位置與素材：',
    '',
    positions.join('\n\n'),
    '',
    '輸出格式：',
    '{"positions":[{"id":"<位置 id>","start":<秒>,"end":<秒>,"kind":"title"|"caption","text":"<文案>"}],',
    ' "title":"<短影片標題>","description":"<一兩句描述>","hashtags":["<標籤>"]}',
    'positions 依骨架順序排列，略過的位置就不要出現。',
  ].join('\n');
}

interface RawPosition {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly kind: Card['kind'];
  readonly text: string;
}

function parsePositions(
  raw: unknown,
  category: Category,
  span: Span,
): { selections: Selection[]; title: string; description: string; hashtags: string[] } {
  if (typeof raw !== 'object' || raw === null) {
    throw new ExternalToolError('anthropic', null, '規劃結果不是物件');
  }
  const record = raw as Record<string, unknown>;
  const byId = new Map(category.skeleton.map((position) => [position.id, position]));

  const selections: Selection[] = [];
  for (const entry of Array.isArray(record['positions']) ? record['positions'] : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Partial<RawPosition>;
    const position = typeof item.id === 'string' ? byId.get(item.id) : undefined;
    if (position === undefined) continue;
    if (typeof item.start !== 'number' || typeof item.end !== 'number' || item.end <= item.start) continue;
    if (typeof item.text !== 'string' || item.text.trim().length === 0) continue;

    // 夾回允許範圍：模型偶爾會挑到範圍外，靜靜採用會剪到別筆交易的畫面。
    const bounds = positionBounds(position, span);
    const start = Math.max(item.start, bounds.from);
    const end = Math.min(item.end, bounds.to);
    if (end <= start) continue;

    selections.push({
      positionId: position.id,
      framing: position.framing,
      start,
      end,
      cardText: item.text.trim(),
      cardKind: item.kind === 'title' ? 'title' : 'caption',
    });
  }

  // 依骨架順序排列，不信任模型的輸出順序。
  const order = new Map(category.skeleton.map((position, index) => [position.id, index]));
  selections.sort((a, b) => (order.get(a.positionId) ?? 0) - (order.get(b.positionId) ?? 0));

  const hashtags = Array.isArray(record['hashtags'])
    ? record['hashtags'].filter((tag): tag is string => typeof tag === 'string')
    : [];

  return {
    selections,
    title: typeof record['title'] === 'string' && record['title'].length > 0 ? record['title'] : `${span.outcome}的一筆交易`,
    description: typeof record['description'] === 'string' ? record['description'] : '',
    hashtags,
  };
}

/** 不可略過的位置必須都在，否則這支短片沒有骨幹。 */
function assertRequiredPositions(selections: readonly Selection[], category: Category): void {
  const present = new Set(selections.map((selection) => selection.positionId));
  const missing = category.skeleton
    .filter((position) => !position.collapsible && !present.has(position.id))
    .map((position) => position.id);

  if (missing.length > 0) {
    throw new ExternalToolError(
      'anthropic',
      null,
      `這個區段缺少必要的骨架位置：${missing.join('、')}。取材窗口內可能沒有對應內容。`,
    );
  }
}

export interface BuildPlanOptions {
  readonly span: Span;
  readonly transcript: Transcript;
  readonly category: Category;
  readonly cacheDir: string;
}

export interface PlanResult {
  readonly plan: Plan;
  /** 相對目標長度的差距，讓使用者知道這支片偏長還是偏短。 */
  readonly durationDelta: number;
}

export async function buildPlan(options: BuildPlanOptions): Promise<PlanResult> {
  const { text } = await ask({
    system: SYSTEM,
    prompt: buildPrompt(options.span, options.category, options.transcript),
    maxTokens: 4096,
    cacheDir: options.cacheDir,
  });

  const parsed = parsePositions(extractJson(text), options.category, options.span);
  assertRequiredPositions(parsed.selections, options.category);

  const timeline = buildTimeline(parsed.selections);

  const plan: Plan = {
    source: {
      video: options.transcript.source.video,
      width: 0,
      height: 0,
    },
    span: {
      index: options.span.index,
      openAt: options.span.openAt,
      closeAt: options.span.closeAt,
      outcome: options.span.outcome,
    },
    cuts: timeline.cuts,
    cards: timeline.cards,
    metadata: {
      title: parsed.title,
      description: parsed.description,
      hashtags: parsed.hashtags,
    },
  };

  return { plan, durationDelta: timeline.durationSeconds - options.category.duration.target };
}

export { readingSeconds };
