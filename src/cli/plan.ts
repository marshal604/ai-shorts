import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildPlan } from '../plan/plan.ts';
import { probeDimensions } from '../render/framing.ts';
import { trading } from '../categories/trading.ts';
import type { AnchorDocument, Transcript } from '../types.ts';

const USAGE = `用法：npm run plan -- <anchors.json>

把每個區段規劃成一份 plan.json：從取材窗口裡依內容挑素材、產出文案卡。
文案長度決定片段長度，倍速由此推導 —— 骨架不規定時間也不規定倍速。
LLM 回應以輸入雜湊快取，同樣輸入重跑不再發出請求。

stdout 輸出每份計畫的路徑，進度走 stderr。`;

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

const stamp = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

async function main(): Promise<void> {
  const input = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (input === undefined) {
    log(USAGE);
    process.exitCode = 1;
    return;
  }

  const anchorsPath = resolve(input);
  const jobDir = dirname(anchorsPath);
  const anchors = JSON.parse(await readFile(anchorsPath, 'utf8')) as AnchorDocument;
  const transcript = JSON.parse(
    await readFile(join(jobDir, 'transcript.json'), 'utf8'),
  ) as Transcript;

  if (anchors.spans.length === 0) {
    log('沒有完整的區段可以規劃。檢查 anchors.json 的 unpaired 看看是不是漏了宣告。');
    process.exitCode = 1;
    return;
  }

  const dimensions = await probeDimensions(anchors.source.video);
  log(`${anchors.spans.length} 個區段，來源 ${dimensions.width}x${dimensions.height}`);

  let failed = 0;
  for (const span of anchors.spans) {
    log(`\n區段 #${span.index}  ${stamp(span.openAt)}–${stamp(span.closeAt)}  ${span.outcome}`);
    try {
    const { plan, durationDelta } = await buildPlan({
      span,
      transcript,
      category: trading,
      cacheDir: join(jobDir, '.cache'),
    });

    const withSource = { ...plan, source: { ...plan.source, ...dimensions } };
    const path = join(jobDir, `plan-${String(span.index).padStart(2, '0')}.json`);
    await writeFile(path, `${JSON.stringify(withSource, null, 2)}\n`, 'utf8');

    const total = plan.cards.length > 0 ? (plan.cards[plan.cards.length - 1]?.end ?? 0) : 0;
    log(`  ${plan.cuts.length} 個片段、${plan.cards.length} 張卡，約 ${total.toFixed(1)} 秒（目標 ${trading.duration.target}，差 ${durationDelta > 0 ? '+' : ''}${durationDelta.toFixed(1)}）`);
    plan.cuts.forEach((cut, index) => {
      log(`  ${cut.positionId.padEnd(8)} ${stamp(cut.start)}–${stamp(cut.end)}  ${cut.speed ? `${cut.speed}x` : '原速'}`);
      const card = plan.cards[index];
      if (card !== undefined) log(`           ${card.kind === 'title' ? '標題' : '字幕'}「${card.text}」`);
    });
    process.stdout.write(`${path}\n`);
    } catch (error: unknown) {
      // 一個區段失敗不該讓後面的區段一起沒了 —— 它們彼此獨立。
      failed += 1;
      log(`  ⚠ 這個區段規劃失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed > 0) {
    log(`\n${failed} 個區段沒有產出計畫，其餘已完成。`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
