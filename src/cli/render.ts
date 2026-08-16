import { readFile } from 'node:fs/promises';
import { renderPlan, validatePlan } from '../render/render.ts';
import { planDuration } from '../render/filtergraph.ts';
import { resolveMusic } from '../render/music.ts';
import { trading } from '../categories/trading.ts';
import type { MusicConfig } from '../types.ts';
import { parseArgs } from './args.ts';

const USAGE = `用法：npm run render -- <plan.json> [--out <目錄>] [--music <音樂檔>]

依計畫渲染出一支 1080x1920 短影片與對應的 metadata 檔。
短影片不含講者原聲，敘事由文案卡承載，音軌是背景音樂。
未指定 --music 時使用程式生成的環境底樂。

stdout 只輸出成品路徑（方便串接），進度走 stderr。`;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

function musicFor(musicPath: string | undefined): MusicConfig {
  return musicPath === undefined ? trading.music : { ...trading.music, path: musicPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }

  // 先驗形狀再讀欄位 —— 手改壞的計畫要以看得懂的訊息失敗，不是 TypeError。
  const plan: unknown = JSON.parse(await readFile(args.planPath, 'utf8'));
  validatePlan(plan);

  const resolved = await resolveMusic(musicFor(args.musicPath));
  if (resolved.warning !== undefined) log(`⚠ ${resolved.warning}`);
  const music = resolved.music;
  log(
    `[${plan.span.outcome}] 區段 ${plan.span.index}，${plan.cuts.length} 個片段、` +
      `${plan.cards.length} 張文案卡，預計 ${planDuration(plan).toFixed(1)} 秒`,
  );
  log(`音樂：${music.path ?? '程式生成的環境底樂'}`);
  log('渲染中…');

  const result = await renderPlan(plan, args.outDir, music);

  log(`完成：${result.durationSeconds.toFixed(2)} 秒`);
  log(`metadata：${result.metadataPath}`);
  process.stdout.write(`${result.videoPath}\n`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
