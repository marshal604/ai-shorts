import { basename, join } from 'node:path';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { transcribe } from '../transcribe/transcribe.ts';
import { prepareTranscript } from '../transcribe/correct.ts';
import { trading } from '../categories/trading.ts';

const USAGE = `用法：npm run transcribe -- <影片檔> [--out <目錄>] [--force]

抽音、在本機做語音辨識，產出含逐段時間碼的逐字稿。
產物已存在且來源未變時預設沿用，加 --force 強制重跑。

stdout 只輸出逐字稿路徑，進度走 stderr。`;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function jobName(video: string): string {
  return basename(video).replace(/\.[^.]+$/, '').replace(/[/\\:*?"<>|\s]/g, '_');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const video = argv.find((arg) => !arg.startsWith('--'));
  if (video === undefined) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }
  const outFlag = argv.indexOf('--out');
  const outDir = resolve(outFlag >= 0 ? (argv[outFlag + 1] ?? 'out') : 'out');
  const outputPath = join(outDir, jobName(video), 'transcript.json');

  log(`轉錄中…（本機執行，長片需要數分鐘）`);
  const { transcript, reused } = await transcribe({
    video: resolve(video),
    outputPath,
    category: trading,
    force: argv.includes('--force'),
  });

  log(reused ? '沿用既有逐字稿（加 --force 可強制重跑）' : '轉錄完成');
  log(`${transcript.segments.length} 段 / ${Math.round(transcript.source.durationSeconds)} 秒`);

  // 先把逐字稿校正成正確的，再讓下游使用 —— 否則偵測、分類、文案
  // 每一層都要各自容錯，而且各錯各的。
  log('校正錯字並標記事件中…');
  const jobDir = join(outDir, jobName(video));
  const prepared = await prepareTranscript({
    transcript,
    category: trading,
    cacheDir: join(jobDir, '.cache'),
  });
  await writeFile(join(jobDir, 'transcript.raw.json'), `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
  await writeFile(outputPath, `${JSON.stringify(prepared.transcript, null, 2)}\n`, 'utf8');
  log(`校正 ${prepared.changedSegments} 段、標記 ${prepared.markedEvents} 個事件（原始版保留在 transcript.raw.json）`);

  process.stdout.write(`${outputPath}\n`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
