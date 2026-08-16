import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../exec.ts';
import { PlanValidationError } from '../errors.ts';
import type { Card, Cut, MusicConfig, Plan } from '../types.ts';
import { buildFfmpegArgs, cutDuration, planDuration } from './filtergraph.ts';
import { measureCard, renderCardPng } from './text.ts';

export interface RenderResult {
  readonly videoPath: string;
  readonly metadataPath: string;
  readonly durationSeconds: number;
  readonly cardCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

function validateSource(source: unknown, problems: string[]): void {
  if (!isRecord(source)) {
    problems.push('缺少 source 物件');
    return;
  }
  if (!isNonEmptyString(source['video'])) {
    problems.push('source.video 必須是非空字串');
  }
  for (const key of ['width', 'height'] as const) {
    const value = source[key];
    if (!isFiniteNumber(value) || value <= 0) {
      problems.push(`source.${key} 必須為正數`);
    }
  }
}

function validateSpan(span: unknown, problems: string[]): void {
  if (!isRecord(span)) {
    problems.push('缺少 span 物件');
    return;
  }
  for (const key of ['openAt', 'closeAt'] as const) {
    if (!isFiniteNumber(span[key])) {
      problems.push(`span.${key} 必須是數字`);
    }
  }
  // index 會直接進檔名，負數或小數會產出難以辨識的檔案。
  const index = span['index'];
  if (!isFiniteNumber(index) || !Number.isInteger(index) || index < 0) {
    problems.push('span.index 必須是非負整數');
  }
  if (!isNonEmptyString(span['outcome'])) {
    problems.push('span.outcome 必須是非空字串');
  }
}

function validateCut(cut: unknown, index: number, problems: string[]): void {
  if (!isRecord(cut)) {
    problems.push(`cuts[${index}]：必須是物件`);
    return;
  }
  const label = `cuts[${index}] (${isNonEmptyString(cut['positionId']) ? cut['positionId'] : '未命名'})`;
  if (!isNonEmptyString(cut['positionId'])) {
    problems.push(`${label}：positionId 必須是非空字串`);
  }
  const start = cut['start'];
  const end = cut['end'];

  if (!isFiniteNumber(start) || start < 0) {
    problems.push(`${label}：start 必須是非負數字`);
  }
  if (!isFiniteNumber(end)) {
    problems.push(`${label}：end 必須是數字`);
  } else if (isFiniteNumber(start) && end <= start) {
    problems.push(`${label}：end 必須大於 start`);
  }
  if (cut['framing'] !== 'full' && cut['framing'] !== 'roi') {
    problems.push(`${label}：framing 必須是 full 或 roi`);
  }

  const speed = cut['speed'];
  if (speed !== undefined && (!isFiniteNumber(speed) || speed <= 0)) {
    problems.push(`${label}：speed 必須為正數`);
  }
}

function validateCard(card: unknown, index: number, total: number, problems: string[]): void {
  if (!isRecord(card)) {
    problems.push(`cards[${index}]：必須是物件`);
    return;
  }
  const label = `cards[${index}]`;
  if (card['kind'] !== 'title' && card['kind'] !== 'caption') {
    problems.push(`${label}：kind 必須是 title 或 caption`);
  }
  const kind = card['kind'];
  if (!isNonEmptyString(card['text'])) {
    problems.push(`${label}：text 必須是非空字串`);
  } else if (kind === 'title' || kind === 'caption') {
    const fit = measureCard(kind, card['text']);
    if (fit.overflows) {
      problems.push(
        `${label}：這段文字會斷成 ${fit.lines} 行，超過 ${kind} 的 ${fit.maxLines} 行上限；` +
          '超出的行會被靜靜截掉，而卡就是敘事本身',
      );
    }
  }

  const start = card['start'];
  const end = card['end'];
  if (!isFiniteNumber(start) || start < 0) {
    problems.push(`${label}：start 必須是非負數字`);
  }
  if (!isFiniteNumber(end)) {
    problems.push(`${label}：end 必須是數字`);
    return;
  }
  if (isFiniteNumber(start) && end <= start) {
    problems.push(`${label}：end 必須大於 start`);
  }
  // 卡的時間是成品時間軸，落在片尾之後就永遠不會顯示。
  if (isFiniteNumber(start) && start >= total) {
    problems.push(`${label}：start 超出成品長度 ${total.toFixed(2)} 秒，這張卡不會出現`);
  }
}

function validateMetadata(metadata: unknown, problems: string[]): void {
  if (!isRecord(metadata)) {
    problems.push('缺少 metadata 物件');
    return;
  }
  if (!isNonEmptyString(metadata['title'])) problems.push('metadata.title 必須是非空字串');
  if (typeof metadata['description'] !== 'string') problems.push('metadata.description 必須是字串');
  if (!Array.isArray(metadata['hashtags']) || metadata['hashtags'].some((t) => typeof t !== 'string')) {
    problems.push('metadata.hashtags 必須是字串陣列');
  }
}

/**
 * 同一種卡疊在畫面的同一個帶狀區。兩張時間重疊的話會同時畫上去，
 * 字直接糊成一團 —— 而且要等成品播出來才看得出來。
 */
function validateCardOverlaps(cards: readonly unknown[], problems: string[]): void {
  const typed = cards
    .map((card, index) => ({ card, index }))
    .filter((entry): entry is { card: Record<string, unknown>; index: number } => isRecord(entry.card))
    .filter(({ card }) => isFiniteNumber(card['start']) && isFiniteNumber(card['end']));

  for (let a = 0; a < typed.length; a += 1) {
    for (let b = a + 1; b < typed.length; b += 1) {
      const first = typed[a];
      const second = typed[b];
      if (first === undefined || second === undefined) continue;
      if (first.card['kind'] !== second.card['kind']) continue;

      const startA = first.card['start'] as number;
      const endA = first.card['end'] as number;
      const startB = second.card['start'] as number;
      const endB = second.card['end'] as number;
      if (startA < endB && startB < endA) {
        problems.push(
          `cards[${first.index}] 與 cards[${second.index}] 都是 ${String(first.card['kind'])} 且時間重疊，` +
            '會疊在同一塊區域上',
        );
      }
    }
  }
}

/**
 * 計畫是可以被人手動編輯的契約，所以不能假設它是自己寫出來的 ——
 * 連形狀都要驗，否則手改壞的檔案會以難懂的 TypeError 收場。
 * 這裡只驗結構，不驗內容好不好；內容好不好是使用者的判斷。
 */
export function validatePlan(plan: unknown): asserts plan is Plan {
  if (!isRecord(plan)) {
    throw new PlanValidationError('計畫不合法：\n- 最外層必須是一個物件');
  }

  const problems: string[] = [];
  validateSource(plan['source'], problems);
  validateSpan(plan['span'], problems);
  validateMetadata(plan['metadata'], problems);

  const cuts = plan['cuts'];
  if (!Array.isArray(cuts) || cuts.length === 0) {
    problems.push('cuts 必須是非空陣列 —— 沒有片段就沒有短影片');
  } else {
    cuts.forEach((cut, index) => validateCut(cut, index, problems));
  }

  // 卡片陣列可以是空的（沒有文字仍然渲染得出影片），但不可以缺席 ——
  // 下游一律直接取用 plan.cards，缺席會炸成這個驗證器存在的意義所在的那種 TypeError。
  const cards = plan['cards'];
  if (!Array.isArray(cards)) {
    problems.push('cards 必須是陣列（可以是空陣列，但不可以缺席）');
  } else if (Array.isArray(cuts)) {
    const total = cuts
      .filter((cut): cut is Cut => isRecord(cut) && isFiniteNumber(cut['start']) && isFiniteNumber(cut['end']))
      .reduce((sum, cut) => sum + cutDuration(cut), 0);
    cards.forEach((card, index) => validateCard(card, index, total, problems));
    validateCardOverlaps(cards, problems);
  }

  if (problems.length > 0) {
    throw new PlanValidationError(`計畫不合法：\n- ${problems.join('\n- ')}`);
  }
}

/** 分秒拆開回傳，不透過字串來回切 —— 超過 99 分鐘時字串切法會錯位。 */
function splitTime(seconds: number): { readonly mm: string; readonly ss: string } {
  const total = Math.max(0, Math.floor(seconds));
  return {
    mm: String(Math.floor(total / 60)).padStart(2, '0'),
    ss: String(total % 60).padStart(2, '0'),
  };
}

function timecode(seconds: number): string {
  const { mm, ss } = splitTime(seconds);
  return `${mm}${ss}`;
}

export function readableTimecode(seconds: number): string {
  const { mm, ss } = splitTime(seconds);
  return `${mm}:${ss}`;
}

/**
 * 結果是自由文字（手改或由 LLM 產生），直接接進路徑會讓 `../` 逃出輸出目錄，
 * 而且要等整段 ffmpeg 編碼跑完才會失敗。
 */
function safeFilenameSegment(value: string): string {
  const cleaned = value.trim().replace(/[/\\:*?"<>|\s]/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

export function outputBasename(plan: Plan): string {
  const index = String(plan.span.index).padStart(2, '0');
  const outcome = safeFilenameSegment(plan.span.outcome);
  return `${index}-${timecode(plan.span.openAt)}-${outcome}`;
}

function metadataMarkdown(plan: Plan, durationSeconds: number): string {
  const cutRow = (cut: Cut): string =>
    `| ${cut.positionId} | ${readableTimecode(cut.start)}–${readableTimecode(cut.end)} | ` +
    `${cut.framing} | ${cut.speed ?? 1}x | ${cutDuration(cut).toFixed(2)}s |`;

  const cardRow = (card: Card): string =>
    `| ${card.kind} | ${card.start.toFixed(1)}–${card.end.toFixed(1)}s | ${card.text} |`;

  return [
    `# ${plan.metadata.title}`,
    '',
    plan.metadata.description,
    '',
    plan.metadata.hashtags.map((tag) => `#${tag}`).join(' '),
    '',
    '## 來源',
    '',
    `- 長影片：${plan.source.video}`,
    `- 區段：${readableTimecode(plan.span.openAt)}–${readableTimecode(plan.span.closeAt)}`,
    `- 結果：${plan.span.outcome}`,
    `- 成品長度：${durationSeconds.toFixed(2)} 秒`,
    '',
    '## 片段',
    '',
    '| 位置 | 長影片時間 | 構圖 | 倍速 | 成品長度 |',
    '|---|---|---|---|---|',
    ...plan.cuts.map(cutRow),
    '',
    '## 文案卡',
    '',
    '| 類型 | 成品時間 | 文字 |',
    '|---|---|---|',
    ...plan.cards.map(cardRow),
    '',
  ].join('\n');
}

async function writeCardImages(cards: readonly Card[], directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const [index, card] of cards.entries()) {
    const path = join(directory, `card-${String(index).padStart(2, '0')}.png`);
    await writeFile(path, renderCardPng(card));
    paths.push(path);
  }
  return paths;
}

/** 依計畫渲染出一支短影片與對應的 metadata 檔。 */
export async function renderPlan(
  plan: Plan,
  outputDir: string,
  music: MusicConfig,
): Promise<RenderResult> {
  validatePlan(plan);
  await mkdir(outputDir, { recursive: true });

  const basename = outputBasename(plan);
  const videoPath = join(outputDir, `${basename}.mp4`);
  const metadataPath = join(outputDir, `${basename}.md`);
  const durationSeconds = planDuration(plan);

  const workDir = await mkdtemp(join(tmpdir(), 'ai-shorts-cards-'));
  try {
    const cardImagePaths = await writeCardImages(plan.cards, workDir);
    await run('ffmpeg', buildFfmpegArgs(plan, { outputPath: videoPath, cardImagePaths, music }));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  await writeFile(metadataPath, metadataMarkdown(plan, durationSeconds), 'utf8');

  return { videoPath, metadataPath, durationSeconds, cardCount: plan.cards.length };
}
