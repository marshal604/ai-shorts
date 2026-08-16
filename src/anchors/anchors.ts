import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Anchor, AnchorDocument, Category, Transcript } from '../types.ts';
import { classifyCandidates } from './classify.ts';
import { detectCandidates } from './detect.ts';
import { normalizeTranscript } from './normalize.ts';
import { buildSpans } from './spans.ts';

export interface BuildAnchorsOptions {
  readonly transcript: Transcript;
  readonly category: Category;
  readonly cacheDir: string;
}

export interface AnchorsResult {
  readonly document: AnchorDocument;
  readonly candidateCount: number;
}

/**
 * 逐字稿 → 錨點文件。
 *
 * 偵測與分類分離：前綴比對負責召回（決定性、免費、不會漏），
 * 分類器負責精確度（吸收語音辨識變體、濾掉講解句）。見 ADR-0001。
 */
export async function buildAnchors(options: BuildAnchorsOptions): Promise<AnchorsResult> {
  const normalized = normalizeTranscript(options.transcript);
  const candidates = detectCandidates(normalized, options.category.locator);
  const anchors: Anchor[] = await classifyCandidates(candidates, options.category.locator, {
    cacheDir: options.cacheDir,
  });

  const { spans, unpaired } = buildSpans(
    anchors,
    options.category,
    options.transcript.source.durationSeconds,
  );

  return {
    document: { source: options.transcript.source, anchors, spans, unpaired },
    candidateCount: candidates.length,
  };
}

export async function writeAnchorDocument(document: AnchorDocument, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}
