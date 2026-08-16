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
  //
  // 每個位置的倍速由「這段畫面本身要多久才看得懂」決定，不再受說話速度綁架 ——
  // 短影片不帶原聲，敘事由文案卡承載。講解段壓得最兇，揭曉段維持原速當落點。
  skeleton: [
    {
      id: 'hook',
      source: { anchor: 'close', from: -2, to: 1 },
      framing: 'roi',
      collapsible: false,
    },
    {
      id: 'context',
      source: { anchor: 'open', from: -83, to: -69 },
      framing: 'full',
      speed: 2.5,
      collapsible: true,
    },
    {
      id: 'setup',
      source: { anchor: 'open', from: -55, to: -42 },
      framing: 'roi',
      speed: 2,
      collapsible: true,
    },
    {
      id: 'entry',
      source: { anchor: 'open', from: -2, to: 7 },
      framing: 'roi',
      speed: 1.5,
      collapsible: false,
    },
    {
      id: 'holding',
      source: { anchor: 'open', from: 7, to: 17 },
      framing: 'full',
      speed: 8,
      collapsible: true,
    },
    {
      id: 'reveal',
      source: { anchor: 'close', from: -3, to: 7 },
      framing: 'roi',
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

  // 長度由文案卡的字數決定，不再由說話節奏決定。
  duration: { target: 35, min: 25, max: 50 },

  // 未指定 path 就用程式生成的環境底樂：沒有版權持有人，也不會被平台認領。
  music: { gainDb: -14, fadeInSeconds: 1.5, fadeOutSeconds: 2 },
};
