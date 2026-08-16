import { fileURLToPath } from 'node:url';
import type { Category } from '../types.ts';

/**
 * 交易分析類別。
 *
 * 事件以自然語言描述，由來源準備階段依語意標記 —— 講者不必說出固定字眼，
 * 「這筆進場」「這邊就進場」「我現在進了」都算數（ADR-0001）。
 */
export const trading: Category = {
  name: '交易分析',

  vocabulary: {
    events: [
      {
        id: 'entry',
        role: 'open',
        description: '講者宣告自己現在進場、下單建立部位',
      },
      {
        id: 'take-profit',
        role: 'close',
        description: '講者宣告這筆交易觸及停利出場',
        outcome: '止盈',
      },
      {
        id: 'stop-loss',
        role: 'close',
        description: '講者宣告這筆交易觸及停損出場',
        outcome: '止損',
      },
      {
        id: 'partial-take-profit',
        role: 'close',
        description: '講者宣告這筆交易部分獲利了結、剩餘部位保本出場',
        outcome: '部分止盈',
      },
    ],
  },

  // 骨架：結果先破梗當鉤子，其餘依時序推進。
  //
  // 只規定順序、意圖與取材上界。實際取哪一段、放多快，由規劃器依內容決定 ——
  // 骨架寫死位移會盲目抓走「錨點前 N 秒」不管那裡在講什麼。
  skeleton: [
    {
      id: 'hook',
      cardBrief: '結果與風報比：止盈或止損，以及這筆的 RR 是多少。這是破梗，要最短最直接。',
      source: { anchor: 'close', direction: 'around', reach: 6 },
      collapsible: false,
    },
    {
      id: 'context',
      cardBrief: '斐波那契設置或當下關注的關鍵點位，說明進場前在等什麼。',
      source: { anchor: 'open', direction: 'before', reach: 180 },
      collapsible: true,
    },
    {
      id: 'setup',
      cardBrief: '關鍵 K 棒與進場原因：是哪一根、為什麼是這裡。',
      source: { anchor: 'open', direction: 'before', reach: 120 },
      collapsible: true,
    },
    {
      id: 'entry',
      cardBrief: '實際進場的方向與停損停利設定，含風報比。',
      source: { anchor: 'open', direction: 'around', reach: 20 },
      collapsible: false,
    },
    {
      id: 'holding',
      cardBrief: '持倉過程加速走向停利或停損，可加一句簡短旁白帶節奏。',
      source: { anchor: 'open', direction: 'after', reach: 60 },
      collapsible: true,
    },
    {
      id: 'reveal',
      cardBrief: '最終結果：止盈或止損，以及是怎麼收掉的。',
      source: { anchor: 'close', direction: 'around', reach: 20 },
      collapsible: false,
    },
  ],

  glossary: {
    FBG: 'FVG',
    小肥波: '小 FVG',
    肥波: 'FVG',
    只贏: '止盈',
    止音: '止盈',
    止存: '止損',
  },

  // 長度由文案卡的字數決定，不再由說話節奏決定。
  duration: { target: 35, min: 25, max: 50 },

  // YouTube 音樂庫的曲目（Wayne Jones - A Quiet Thought）。音訊資產不進版控，
  // 檔案不存在時會自動退回程式生成的環境底樂，見 resolveMusic。
  // 路徑相對於模組而非工作目錄 —— 從任何目錄執行都要指得到。
  music: {
    path: fileURLToPath(new URL('../../assets/music/a-quiet-thought.m4a', import.meta.url)),
    gainDb: -14,
    fadeInSeconds: 1.5,
    fadeOutSeconds: 2,
  },
};
