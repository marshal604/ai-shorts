import type { Cut, Plan } from '../types.ts';
import { BACKGROUND, CANVAS, OUTPUT_FPS, chartPlacement } from './layout.ts';

const SAMPLE_RATE = 48_000;

/** 片段輸出到成品上的實際秒數（快轉後）。 */
export function cutDuration(cut: Cut): number {
  return (cut.end - cut.start) / (cut.speed ?? 1);
}

export function planDuration(plan: Plan): number {
  return plan.cuts.reduce((total, cut) => total + cutDuration(cut), 0);
}

/**
 * 每個片段各開一次輸入並以 -ss 快速定位，而不是單一輸入配 trim 濾鏡 ——
 * trim 會從頭解碼，在十分鐘的 60fps 素材上慢得無法接受。
 */
function inputArgs(plan: Plan): string[] {
  return plan.cuts.flatMap((cut) => [
    '-ss',
    cut.start.toFixed(3),
    '-t',
    (cut.end - cut.start).toFixed(3),
    '-i',
    plan.source.video,
  ]);
}

function videoChain(cut: Cut, index: number, sourceWidth: number, sourceHeight: number): string {
  const place = chartPlacement(sourceWidth, sourceHeight, cut.framing);
  const speed = cut.speed ?? 1;
  const pts = speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed}`;

  return [
    `[${index}:v]setpts=${pts}`,
    `fps=${OUTPUT_FPS}`,
    `crop=${place.crop.width}:${place.crop.height}:${place.crop.x}:${place.crop.y}`,
    `scale=${place.scaledWidth}:${place.scaledHeight}`,
    `pad=${CANVAS.width}:${CANVAS.height}:${place.offsetX}:${place.offsetY}:color=${BACKGROUND}`,
    `setsar=1[v${index}]`,
  ].join(',');
}

/**
 * 靜音片段不沿用原聲，而是生成等長的無聲軌 —— 快轉會讓聲音變調，
 * 且鉤子與揭曉若都帶原聲會播到同一句話。
 */
function audioChain(cut: Cut, index: number): string {
  if (cut.audio === 'mute') {
    return [
      `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`,
      `atrim=duration=${cutDuration(cut).toFixed(3)}`,
      `asetpts=PTS-STARTPTS[a${index}]`,
    ].join(',');
  }
  return [
    `[${index}:a]asetpts=PTS-STARTPTS`,
    `aresample=${SAMPLE_RATE}`,
    `aformat=sample_fmts=fltp:channel_layouts=mono[a${index}]`,
  ].join(',');
}

function filterComplex(plan: Plan): string {
  const { width, height } = plan.source;
  const chains = plan.cuts.flatMap((cut, index) => [
    videoChain(cut, index, width, height),
    audioChain(cut, index),
  ]);

  const labels = plan.cuts.map((_, index) => `[v${index}][a${index}]`).join('');
  chains.push(`${labels}concat=n=${plan.cuts.length}:v=1:a=1[outv][outa]`);

  return chains.join(';');
}

/** 組出完整的 ffmpeg 參數。純函式 —— 不碰檔案系統，方便直接斷言。 */
export function buildFfmpegArgs(plan: Plan, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    ...inputArgs(plan),
    '-filter_complex',
    filterComplex(plan),
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-y',
    outputPath,
  ];
}
