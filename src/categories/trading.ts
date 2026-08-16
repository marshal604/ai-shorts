import type { Category } from '../types.ts';

/**
 * 交易分析類別。
 *
 * 事件不列語音辨識變體 —— 偵測靠「這筆」前綴（決定性），
 * 分類與過濾交給 LLM 讀 description 判斷（ADR-0001）。實測變體包括
 * 止盈→只贏／止音、止損→止存／简体「损」，人工白名單維護不完。
 */
export const trading: Category = {
  name: '交易分析',

  locator: {
    kind: 'cue',
    prefix: '這筆',
    proximity: 24,
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
  // 位置 1 靜音是為了不跟位置 6 播同一句話。
  skeleton: [
    {
      id: 'hook',
      source: { anchor: 'close', from: -2, to: 1 },
      framing: 'roi',
      audio: 'mute',
      collapsible: false,
    },
    {
      id: 'context',
      source: { anchor: 'open', from: -83, to: -69 },
      framing: 'full',
      audio: 'original',
      collapsible: true,
    },
    {
      id: 'setup',
      source: { anchor: 'open', from: -55, to: -42 },
      framing: 'roi',
      audio: 'original',
      collapsible: true,
    },
    {
      id: 'entry',
      source: { anchor: 'open', from: -2, to: 7 },
      framing: 'roi',
      audio: 'original',
      collapsible: false,
    },
    {
      id: 'holding',
      source: { anchor: 'open', from: 7, to: 17 },
      framing: 'full',
      audio: 'mute',
      speed: 8,
      collapsible: true,
    },
    {
      id: 'reveal',
      source: { anchor: 'close', from: -3, to: 7 },
      framing: 'roi',
      audio: 'original',
      collapsible: false,
    },
  ],

  framing: 'fixed',

  glossary: {
    FBG: 'FVG',
    小肥波: '小 FVG',
    肥波: 'FVG',
    只贏: '止盈',
    止音: '止盈',
    止存: '止損',
  },

  duration: { target: 52, min: 45, max: 60 },
};
