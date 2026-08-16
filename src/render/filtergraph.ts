import type { Card, Cut, MusicConfig, Plan } from '../types.ts';
import { BACKGROUND, CANVAS, OUTPUT_FPS } from './layout.ts';
import { framingWidth, placeInChartBand } from './framing.ts';
import type { FramingPlan } from './framing.ts';
import { buildMusicChain } from './music.ts';

/** 片段輸出到成品上的實際秒數（快轉後）。 */
export function cutDuration(cut: Cut): number {
  return (cut.end - cut.start) / (cut.speed ?? 1);
}

export function planDuration(plan: Plan): number {
  return plan.cuts.reduce((total, cut) => total + cutDuration(cut), 0);
}

export interface RenderInputs {
  readonly outputPath: string;
  /** 每張文案卡對應一個已寫到磁碟的透明點陣圖。順序需與 plan.cards 一致。 */
  readonly cardImagePaths: readonly string[];
  /** 每個片段各自的裁切計畫，順序需與 plan.cuts 一致（ADR-0003）。 */
  readonly framings: readonly FramingPlan[];
  readonly music: MusicConfig;
}

/**
 * 每個片段各開一次輸入並以 -ss 快速定位，而不是單一輸入配 trim 濾鏡 ——
 * trim 會從頭解碼，在十分鐘的 60fps 素材上慢得無法接受。
 */
function cutInputArgs(plan: Plan): string[] {
  return plan.cuts.flatMap((cut) => [
    '-ss',
    cut.start.toFixed(3),
    '-t',
    (cut.end - cut.start).toFixed(3),
    '-i',
    plan.source.video,
  ]);
}

/** 文案卡是靜態圖，以固定影格率鋪滿成品長度，實際顯示時間由 overlay 的 enable 控制。 */
function cardInputArgs(paths: readonly string[], duration: number): string[] {
  return paths.flatMap((path) => [
    '-loop',
    '1',
    '-framerate',
    String(OUTPUT_FPS),
    '-t',
    duration.toFixed(3),
    '-i',
    path,
  ]);
}

const cropOf = (box: { x: number; y: number; width: number; height: number }): string =>
  `crop=${box.width}:${box.height}:${box.x}:${box.y}`;

/**
 * 一個片段的影像鏈。偵測到獨立的價格軸時，把它水平接到主體右緣，
 * 中間會隨時間變動的死留白就此消失（ADR-0003）。
 */
function videoChain(cut: Cut, index: number, framing: FramingPlan): string[] {
  const speed = cut.speed ?? 1;
  const pts = speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${speed}`;
  const place = placeInChartBand(framingWidth(framing), framing.body.height);
  const tail = [
    `scale=${place.scaledWidth}:${place.scaledHeight}`,
    `pad=${CANVAS.width}:${CANVAS.height}:${place.offsetX}:${place.offsetY}:color=${BACKGROUND}`,
    `setsar=1[v${index}]`,
  ];

  if (framing.axis === undefined) {
    return [
      [`[${index}:v]setpts=${pts}`, `fps=${OUTPUT_FPS}`, cropOf(framing.body), ...tail].join(','),
    ];
  }

  return [
    `[${index}:v]setpts=${pts},fps=${OUTPUT_FPS},split=2[b${index}][a${index}]`,
    `[b${index}]${cropOf(framing.body)}[bc${index}]`,
    `[a${index}]${cropOf(framing.axis)}[ac${index}]`,
    [`[bc${index}][ac${index}]hstack=inputs=2`, ...tail].join(','),
  ];
}

/** 逐張把文案卡疊到已拼接的影像上，各自只在自己的時間區間內顯示。 */
function cardChains(cards: readonly Card[], firstCardInput: number): {
  chains: string[];
  finalLabel: string;
} {
  const chains: string[] = [];
  let current = 'vbase';

  cards.forEach((card, index) => {
    const input = firstCardInput + index;
    const next = `vc${index}`;
    chains.push(`[${input}:v]format=rgba,setsar=1[card${index}]`);
    chains.push(
      `[${current}][card${index}]overlay=0:0:` +
        `enable='between(t,${card.start.toFixed(3)},${card.end.toFixed(3)})'[${next}]`,
    );
    current = next;
  });

  return { chains, finalLabel: current };
}

function filterComplex(plan: Plan, inputs: RenderInputs, duration: number): string {
  const chains = plan.cuts.flatMap((cut, index) =>
    videoChain(cut, index, inputs.framings[index] ?? { body: { x: 0, y: 0, width: plan.source.width, height: plan.source.height } }),
  );

  const concatLabels = plan.cuts.map((_, index) => `[v${index}]`).join('');
  chains.push(`${concatLabels}concat=n=${plan.cuts.length}:v=1:a=0[vbase]`);

  const music = buildMusicChain(inputs.music, duration, plan.cuts.length);
  const firstCardInput = plan.cuts.length + music.inputCount;
  const cards = cardChains(plan.cards, firstCardInput);
  chains.push(...cards.chains);
  chains.push(`[${cards.finalLabel}]format=yuv420p[outv]`);
  chains.push(music.chain);

  return chains.join(';');
}

/** 組出完整的 ffmpeg 參數。純函式 —— 不碰檔案系統，方便直接斷言。 */
export function buildFfmpegArgs(plan: Plan, inputs: RenderInputs): string[] {
  const duration = planDuration(plan);
  const music = buildMusicChain(inputs.music, duration, plan.cuts.length);

  return [
    '-hide_banner',
    '-v',
    'error',
    ...cutInputArgs(plan),
    ...music.inputArgs,
    ...cardInputArgs(inputs.cardImagePaths, duration),
    '-filter_complex',
    filterComplex(plan, inputs, duration),
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
    inputs.outputPath,
  ];
}
