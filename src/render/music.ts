import type { MusicConfig } from '../types.ts';

const SAMPLE_RATE = 48_000;
const OUTPUT_LABEL = 'outa';

/**
 * 生成底樂在套用使用者增益前的補償量。
 *
 * 量測而來：正弦本身已被壓到 -24 dB，aecho 再吃掉約 8 dB，
 * 不補償的話 `gainDb: -20` 會產出 -53 dB 的成品 —— 幾乎聽不見。
 * 補償後 `gainDb` 對兩條路徑（生成底樂與真實曲目）語意一致：
 * 設多少 dB，成品峰值就是多少 dB。
 */
const GENERATED_NORMALIZE_DB = 24;

export interface MusicChain {
  /** 要附加在 ffmpeg 指令上的額外輸入參數（沒有音樂檔時為空）。 */
  readonly inputArgs: readonly string[];
  /** filter_complex 的片段，輸出標籤為 [outa]。 */
  readonly chain: string;
  /** 這段音樂佔用了幾個輸入槽。 */
  readonly inputCount: number;
}

export const DEFAULT_MUSIC: MusicConfig = {
  gainDb: -14,
  fadeInSeconds: 1.5,
  fadeOutSeconds: 2,
};

function fades(music: MusicConfig, duration: number): string {
  const fadeOut = Math.min(music.fadeOutSeconds, duration);
  const fadeOutStart = Math.max(0, duration - fadeOut).toFixed(3);
  return [
    `afade=t=in:st=0:d=${Math.min(music.fadeInSeconds, duration).toFixed(3)}`,
    `afade=t=out:st=${fadeOutStart}:d=${fadeOut.toFixed(3)}`,
  ].join(',');
}

const OUTPUT_FORMAT = `aformat=sample_fmts=fltp:channel_layouts=mono:sample_rates=${SAMPLE_RATE}`;

/**
 * 程式生成的環境底樂：三個低頻正弦疊出的持續音，加上緩慢的音量起伏與短迴聲。
 *
 * 沒有版權持有人，所以不必歸屬、不必把音檔放進版控，也不會觸發平台的內容比對系統。
 * 這是預設值而非唯一選項 —— 類別設定 `music.path` 就會改用真實曲目。
 */
function generatedBed(music: MusicConfig, duration: number): string {
  const seconds = duration.toFixed(3);
  const tone = (frequency: number, level: number, label: string) =>
    `sine=frequency=${frequency}:duration=${seconds}:sample_rate=${SAMPLE_RATE},volume=${level}[${label}]`;

  const body = [
    '[mA][mB][mC]amix=inputs=3:normalize=0',
    'tremolo=f=0.13:d=0.35',
    'lowpass=f=700',
    'aecho=0.8:0.6:350|700:0.28|0.16',
    `volume=${GENERATED_NORMALIZE_DB}dB`,
    'alimiter=limit=0.95',
    // aecho 會拖出約 0.7 秒的尾巴，不裁掉音軌就會比影像長。
    `atrim=duration=${seconds}`,
    'asetpts=PTS-STARTPTS',
    `volume=${music.gainDb}dB`,
    fades(music, duration),
    OUTPUT_FORMAT,
  ].join(',');

  return [
    tone(110, 0.6, 'mA'),
    tone(164.81, 0.35, 'mB'),
    tone(220, 0.18, 'mC'),
    `${body}[${OUTPUT_LABEL}]`,
  ].join(';');
}

/** 使用真實曲目：無限循環後裁到成品長度，短於成品時自動接續。 */
function fileBed(music: MusicConfig, duration: number, inputIndex: number): string {
  const body = [
    `[${inputIndex}:a]atrim=duration=${duration.toFixed(3)}`,
    'asetpts=PTS-STARTPTS',
    `volume=${music.gainDb}dB`,
    fades(music, duration),
    OUTPUT_FORMAT,
  ].join(',');
  return `${body}[${OUTPUT_LABEL}]`;
}

/**
 * 組出短影片唯一的音軌。講者原聲一律丟棄 —— 敘事由文案卡承載，
 * 音軌只是底噪，因此任何片段都可以自由變速而不必擔心聲音變調。
 */
export function buildMusicChain(
  music: MusicConfig,
  duration: number,
  nextInputIndex: number,
): MusicChain {
  if (music.path === undefined) {
    return { inputArgs: [], chain: generatedBed(music, duration), inputCount: 0 };
  }
  return {
    inputArgs: ['-stream_loop', '-1', '-i', music.path],
    chain: fileBed(music, duration, nextInputIndex),
    inputCount: 1,
  };
}
