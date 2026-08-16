import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildAnchors, writeAnchorDocument } from '../anchors/anchors.ts';
import { trading } from '../categories/trading.ts';
import type { Transcript } from '../types.ts';

const USAGE = `用法：npm run anchors -- <transcript.json>

找出長影片裡的錨點與區段，產出 anchors.json。
事件由來源準備階段（transcribe）依語意標記，這裡只負責配對與算取材窗口。
純本機運算，不發出任何網路請求。無法配對的錨點會列出來供確認。

stdout 只輸出錨點檔路徑，進度走 stderr。`;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function stamp(seconds: number): string {
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const input = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (input === undefined) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }

  const transcriptPath = resolve(input);
  const jobDir = dirname(transcriptPath);
  const transcript = JSON.parse(await readFile(transcriptPath, 'utf8')) as Transcript;

  const { document } = buildAnchors({ transcript, category: trading });

  const outputPath = join(jobDir, 'anchors.json');
  await writeAnchorDocument(document, outputPath);

  log(`標記事件 ${document.anchors.length} 個`);
  for (const anchor of document.anchors) {
    log(`  ${stamp(anchor.at)}  ${anchor.role === 'open' ? '開始' : '結束'} ${anchor.eventId}  「${anchor.excerpt}」`);
  }
  log(`區段 ${document.spans.length} 個`);
  for (const span of document.spans) {
    log(`  #${span.index}  ${stamp(span.openAt)}–${stamp(span.closeAt)}  ${span.outcome}`);
  }
  if (document.unpaired.length > 0) {
    log(`⚠ 有 ${document.unpaired.length} 個錨點沒有配到對，可能是漏喊了口令：`);
    for (const anchor of document.unpaired) {
      log(`  ${stamp(anchor.at)}  ${anchor.role === 'open' ? '開始' : '結束'} ${anchor.eventId}`);
    }
  }
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
