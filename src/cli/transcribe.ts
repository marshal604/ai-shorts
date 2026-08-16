import { basename, join, resolve } from 'node:path';
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
  // 帶值旗標的值不可以被當成位置參數 —— 否則 `--out dist video.mov` 會去轉錄 dist。
  const positional: string[] = [];
  let outValue: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    if (arg === '--force') continue;

    // 同時支援 `--out dist` 與 `--out=dist`；不認得的旗標視為用法錯誤 ——
    // 靜靜吞掉打錯的旗標，使用者要等好幾分鐘的轉錄跑完才會發現。
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    if (name !== '--out') {
      log(USAGE);
      process.exitCode = 1;
      return;
    }
    outValue = equals >= 0 ? arg.slice(equals + 1) : argv[index + 1];
    if (outValue === undefined || outValue.length === 0 || outValue.startsWith('--')) {
      log(USAGE);
      process.exitCode = 1;
      return;
    }
    if (equals < 0) index += 1;
  }

  const video = positional[0];
  if (video === undefined) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }
  const outDir = resolve(outValue ?? 'out');
  const jobDir = join(outDir, jobName(video));
  // 語音辨識的原始輸出寫在自己的檔案，準備後的結果寫在 transcript.json。
  // 兩者分開，重跑時才不會拿已經校正過的內容當成原始輸入再校正一次。
  const rawPath = join(jobDir, 'transcript.raw.json');
  const outputPath = join(jobDir, 'transcript.json');

  log(`轉錄中…（本機執行，長片需要數分鐘）`);
  const { transcript, reused } = await transcribe({
    video: resolve(video),
    outputPath: rawPath,
    category: trading,
    force: argv.includes('--force'),
  });

  log(reused ? '沿用既有逐字稿（加 --force 可強制重跑）' : '轉錄完成');
  log(`${transcript.segments.length} 段 / ${Math.round(transcript.source.durationSeconds)} 秒`);

  // 先把逐字稿校正成正確的，再讓下游使用 —— 否則偵測、分類、文案
  // 每一層都要各自容錯，而且各錯各的。
  log('校正錯字並標記事件中…');
  const prepared = await prepareTranscript({
    transcript,
    category: trading,
    cacheDir: join(jobDir, '.cache'),
  });
  await writeFile(outputPath, `${JSON.stringify(prepared.transcript, null, 2)}\n`, 'utf8');
  log(`校正 ${prepared.changedSegments} 段、標記 ${prepared.markedEvents} 個事件（原始版保留在 transcript.raw.json）`);

  process.stdout.write(`${outputPath}\n`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
