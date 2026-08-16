import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from '../exec.ts';
import { ExternalToolError } from '../errors.ts';
import type { Category, Transcript, TranscriptSegment } from '../types.ts';

const MODEL = 'ggml-large-v3-turbo.bin';
const VAD_MODEL = 'ggml-silero-v5.1.2.bin';
const ENGINE = 'whisper.cpp (large-v3-turbo)';

function modelPath(name: string): string {
  return join(homedir(), '.cache/whisper.cpp/models', name);
}

async function probeDuration(video: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    video,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new ExternalToolError('ffprobe', null, `無法取得影片長度：${video}`);
  }
  return seconds;
}

/*
 * 刻意不使用 whisper 的 initial prompt。
 *
 * 原本用它餵術語表以提升專有名詞準確度，實測確實把 `FBG` 修成了 `FVG`，
 * 但代價無法接受 —— 同一份音檔（MD5 相同）對照實驗，各跑兩次：
 *
 *   無 prompt：346 段 / 2266 字 / 549–586 秒有 26 段 / 「這筆進場」正確
 *   有 prompt： 68 段 / 2501 字 / 549–586 秒只剩 2 段 / 變成「這比進場」
 *
 * 它把段落壓成 35 秒一段（毀掉時間精度）、吞掉 38 秒音訊、還把錨點前綴
 * 改成同音錯字。兩次執行結果位元級一致，所以這是決定性的因果關係而非運氣。
 * 專有名詞改在轉錄後做校正，見 correct.ts。
 */

interface WhisperOutput {
  readonly transcription?: readonly {
    readonly offsets?: { readonly from?: number; readonly to?: number };
    readonly text?: string;
  }[];
}

function parseWhisper(raw: string): TranscriptSegment[] {
  const parsed = JSON.parse(raw) as WhisperOutput;
  return (parsed.transcription ?? [])
    .map((entry) => ({
      start: (entry.offsets?.from ?? 0) / 1000,
      end: (entry.offsets?.to ?? 0) / 1000,
      text: (entry.text ?? '').trim(),
    }))
    .filter((segment) => segment.text.length > 0);
}

export interface TranscribeOptions {
  readonly video: string;
  readonly outputPath: string;
  readonly category: Category;
  /** 產物已存在且來源未變時沿用，不重跑 —— 語音辨識是整條管線最貴的一步。 */
  readonly force?: boolean;
}

async function reusable(options: TranscribeOptions): Promise<Transcript | null> {
  if (options.force === true) return null;
  try {
    const existing = JSON.parse(await readFile(options.outputPath, 'utf8')) as Transcript;
    return existing.source.video === options.video ? existing : null;
  } catch {
    return null;
  }
}

/** 抽音、在本機做語音辨識，產出含逐段時間碼的逐字稿。 */
export async function transcribe(options: TranscribeOptions): Promise<{
  readonly transcript: Transcript;
  readonly reused: boolean;
}> {
  const cached = await reusable(options);
  if (cached !== null) return { transcript: cached, reused: true };

  await stat(options.video);
  const durationSeconds = await probeDuration(options.video);

  const workDir = `${options.outputPath}.work`;
  await mkdir(workDir, { recursive: true });
  const wav = join(workDir, 'audio.wav');
  const stem = join(workDir, 'out');

  try {
    await run('ffmpeg', [
      '-v', 'error',
      '-i', options.video,
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      '-y', wav,
    ]);

    await run('whisper-cli', [
      '-m', modelPath(MODEL),
      '--vad', '--vad-model', modelPath(VAD_MODEL),
      '-l', 'zh',
      '-oj', '-of', stem, '-np',
      wav,
    ]);

    const transcript: Transcript = {
      source: { video: options.video, durationSeconds, engine: ENGINE },
      language: 'zh',
      segments: parseWhisper(await readFile(`${stem}.json`, 'utf8')),
    };

    await mkdir(join(options.outputPath, '..'), { recursive: true }).catch(() => undefined);
    await writeFile(options.outputPath, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
    return { transcript, reused: false };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
