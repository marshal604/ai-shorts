import { Resvg } from '@resvg/resvg-js';
import type { Card, CardKind } from '../types.ts';
import { BANDS, CANVAS } from './layout.ts';

/**
 * 文字圖層在 Node 內生成為透明點陣圖，再交給 ffmpeg 疊上（ADR-0002）。
 *
 * 版面只有「置中的一到三行字」，所以直接手寫 SVG 交給 resvg，
 * 不引入 flexbox 排版層 —— 那會需要打包十幾 MB 的中文字型 buffer，
 * 而 resvg 直接用系統字型即可。
 */

const FONT_FAMILY = 'PingFang TC';
const FALLBACK_FAMILY = 'Heiti TC';

interface CardStyle {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly maxCharsPerLine: number;
  readonly maxLines: number;
  readonly centerY: number;
  readonly color: string;
  readonly weight: number;
  readonly backdrop: boolean;
}

const STYLES: Readonly<Record<CardKind, CardStyle>> = {
  title: {
    fontSize: 68,
    lineHeight: 88,
    maxCharsPerLine: 13,
    maxLines: 2,
    centerY: BANDS.title.y + BANDS.title.height / 2,
    color: '#FFFFFF',
    weight: 700,
    backdrop: false,
  },
  caption: {
    fontSize: 54,
    lineHeight: 74,
    maxCharsPerLine: 15,
    maxLines: 3,
    centerY: BANDS.subtitle.y + BANDS.subtitle.height / 2,
    color: '#F2F2F2',
    weight: 500,
    backdrop: true,
  },
};

/** 這些符號不可以出現在行首，遇到就往前一行拉。 */
const NO_LINE_START = '。，、；：！？）」』〉》…·．,.!?:;)]}';

/** 一行最多為了標點多吃幾個字。沒有上限的話連續標點會把整行推出畫布。 */
const MAX_PUNCTUATION_PULL = 2;

/** 最後一行短於這個長度就視為孤字，從上一行搬一個 token 下來。 */
const ORPHAN_THRESHOLD = 2;

/**
 * 可斷行的最小單位：一個中文字，或一整串拉丁字母與數字。
 *
 * 中文可以在任意字之間斷開，但 `FVG`、`1.19`、`4,038.2`、`TP2` 不行 ——
 * 逐字元斷行會產出「FV / G」「1. / 19」這種讀不懂的東西。
 */
const TOKEN = /[A-Za-z0-9]+(?:[.,][A-Za-z0-9]+)*|[\s\S]/gu;

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/**
 * 中文依閱讀單位斷行，不依語音停頓。以 token 為單位貪婪填行，
 * 並避免把標點推到行首。
 */
export function wrapChinese(text: string, maxCharsPerLine: number): string[] {
  const tokens = tokenize(text.trim());
  if (tokens.length === 0) return [];

  const lines: string[] = [];
  let line = '';
  let pulled = 0;

  for (const token of tokens) {
    // 行首的標點往前一行拉，但有上限 —— 連續標點會把整行推出畫布。
    if (line === '' && lines.length > 0 && NO_LINE_START.includes(token) && pulled < MAX_PUNCTUATION_PULL) {
      lines[lines.length - 1] += token;
      pulled += 1;
      continue;
    }

    if (line.length > 0 && line.length + token.length > maxCharsPerLine) {
      lines.push(line);
      line = '';
      pulled = 0;
    }
    line += token;
  }

  if (line.length > 0) lines.push(line);
  return rebalanceOrphan(lines.map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}

/**
 * 最後一行只剩一兩個字（孤字）時，從上一行把最後一個 token 搬下來。
 * 「⋯的反 / 應」讀起來像斷掉，「⋯的 / 反應」才是一個詞。
 */
function rebalanceOrphan(lines: readonly string[]): string[] {
  if (lines.length < 2) return [...lines];

  const last = lines[lines.length - 1] as string;
  const previous = lines[lines.length - 2] as string;
  if (last.length > ORPHAN_THRESHOLD) return [...lines];

  const tokens = tokenize(previous);
  if (tokens.length < 2) return [...lines];

  const moved = tokens[tokens.length - 1] as string;
  return [
    ...lines.slice(0, -2),
    tokens.slice(0, -1).join(''),
    `${moved}${last}`,
  ];
}

/**
 * 損益數字與價位是交易內容裡最抓眼的元素，值得跟其他字區分開。
 *
 * 前面的否定回顧是必要的：沒有它，`TP1`、`TP2` 這種標籤裡的序號也會被染色，
 * 讀起來像是把「第一個停利點」當成了價位。
 */
const EMPHASIS = /(?<![A-Za-z])[+\-−]?\d[\d,]*(?:\.\d+)?(?:\s?[Rr])?/g;
const EMPHASIS_COLOR = '#FFC24B';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把一行字切成一般段落與強調段落，輸出 SVG 的 tspan 序列。 */
export function emphasize(line: string): string {
  const pieces: string[] = [];
  let lastIndex = 0;

  for (const match of line.matchAll(EMPHASIS)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      pieces.push(escapeXml(line.slice(lastIndex, index)));
    }
    pieces.push(
      `<tspan fill="${EMPHASIS_COLOR}" font-weight="700">${escapeXml(match[0])}</tspan>`,
    );
    lastIndex = index + match[0].length;
  }
  if (lastIndex < line.length) {
    pieces.push(escapeXml(line.slice(lastIndex)));
  }

  return pieces.join('');
}

function backdropRect(lines: readonly string[], style: CardStyle): string {
  const width = Math.min(CANVAS.width - 80, style.maxCharsPerLine * style.fontSize + 72);
  const height = lines.length * style.lineHeight + 36;
  const x = (CANVAS.width - width) / 2;
  const y = style.centerY - height / 2;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="24" fill="#000000" fill-opacity="0.55"/>`;
}

/** 產出一張整幅畫布大小的透明 SVG，文字置於該類型對應的帶狀區。 */
export function buildCardSvg(card: Card): string {
  const style = STYLES[card.kind];
  const lines = wrapChinese(card.text, style.maxCharsPerLine).slice(0, style.maxLines);

  const firstBaseline =
    style.centerY - ((lines.length - 1) * style.lineHeight) / 2 + style.fontSize * 0.35;

  const textLines = lines
    .map(
      (line, index) =>
        `<text x="${CANVAS.width / 2}" y="${firstBaseline + index * style.lineHeight}" ` +
        `font-family="${FONT_FAMILY}, ${FALLBACK_FAMILY}" font-size="${style.fontSize}" ` +
        `font-weight="${style.weight}" fill="${style.color}" text-anchor="middle">${emphasize(line)}</text>`,
    )
    .join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}">`,
    style.backdrop && lines.length > 0 ? backdropRect(lines, style) : '',
    textLines,
    '</svg>',
  ].join('');
}

/**
 * 一張卡最多容納幾個字。超過的部分會被截掉 —— 而卡就是敘事本身，
 * 截掉等於句子講一半，所以這個上限要在驗證階段擋下，不能等到成品才發現。
 */
export function maxTextLength(kind: CardKind): number {
  const style = STYLES[kind];
  return style.maxCharsPerLine * style.maxLines;
}

export function renderCardPng(card: Card): Buffer {
  const resvg = new Resvg(buildCardSvg(card), {
    background: 'transparent',
    font: { loadSystemFonts: true, defaultFontFamily: FONT_FAMILY },
  });
  return resvg.render().asPng();
}
