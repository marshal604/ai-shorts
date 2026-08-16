import { readFile } from 'node:fs/promises';
import { renderPlan, validatePlan } from '../render/render.ts';
import { planDuration } from '../render/filtergraph.ts';
import { parseArgs } from './args.ts';

const USAGE = `用法：npm run render -- <plan.json> [--out <目錄>]

依計畫渲染出一支 1080x1920 短影片與對應的 metadata 檔。
stdout 只輸出成品路徑（方便串接），進度走 stderr。`;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
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

  log(
    `[${plan.span.outcome}] 區段 ${plan.span.index}，${plan.cuts.length} 個片段，` +
      `預計 ${planDuration(plan).toFixed(1)} 秒`,
  );
  log('渲染中…');

  const result = await renderPlan(plan, args.outDir);

  log(`完成：${result.durationSeconds.toFixed(2)} 秒`);
  log(`metadata：${result.metadataPath}`);
  process.stdout.write(`${result.videoPath}\n`);
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
