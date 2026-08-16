import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../exec.ts';
import { PlanValidationError } from '../errors.ts';
import type { Cut, Plan } from '../types.ts';
import { buildFfmpegArgs, cutDuration, planDuration } from './filtergraph.ts';

export interface RenderResult {
  readonly videoPath: string;
  readonly metadataPath: string;
  readonly durationSeconds: number;
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
  for (const key of ['index', 'openAt', 'closeAt'] as const) {
    if (!isFiniteNumber(span[key])) {
      problems.push(`span.${key} 必須是數字`);
    }
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
  if (cut['audio'] !== 'original' && cut['audio'] !== 'mute') {
    problems.push(`${label}：audio 必須是 original 或 mute`);
  }

  const speed = cut['speed'];
  if (speed === undefined) return;
  if (!isFiniteNumber(speed) || speed <= 0) {
    problems.push(`${label}：speed 必須為正數`);
    return;
  }
  // 影像被壓縮、聲音沒有，concat 會把片段拉長到音軌長度，
  // 畫面定格而 metadata 記錄的長度也會是錯的。
  if (speed !== 1 && cut['audio'] === 'original') {
    problems.push(`${label}：變速片段必須靜音 —— 原聲不會跟著變速，成品會被拉長到音軌長度`);
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

  if (problems.length > 0) {
    throw new PlanValidationError(`計畫不合法：\n- ${problems.join('\n- ')}`);
  }
}

function timecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}${ss}`;
}

function readableTimecode(seconds: number): string {
  const stamp = timecode(seconds);
  return `${stamp.slice(0, 2)}:${stamp.slice(2)}`;
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
    `${cut.framing} | ${cut.audio} | ${cut.speed ?? 1}x | ${cutDuration(cut).toFixed(2)}s |`;

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
    '| 位置 | 長影片時間 | 構圖 | 音訊 | 倍速 | 成品長度 |',
    '|---|---|---|---|---|---|',
    ...plan.cuts.map(cutRow),
    '',
  ].join('\n');
}

/** 依計畫渲染出一支短影片與對應的 metadata 檔。 */
export async function renderPlan(plan: Plan, outputDir: string): Promise<RenderResult> {
  validatePlan(plan);
  await mkdir(outputDir, { recursive: true });

  const basename = outputBasename(plan);
  const videoPath = join(outputDir, `${basename}.mp4`);
  const metadataPath = join(outputDir, `${basename}.md`);
  const durationSeconds = planDuration(plan);

  await run('ffmpeg', buildFfmpegArgs(plan, videoPath));
  await writeFile(metadataPath, metadataMarkdown(plan, durationSeconds), 'utf8');

  return { videoPath, metadataPath, durationSeconds };
}
