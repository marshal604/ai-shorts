/**
 * 共用資料模型。詞彙定義見 CONTEXT.md，決策依據見 docs/adr/。
 *
 * 引擎只認得這裡的抽象概念（錨點、區段、骨架位置），不認得「進場」或「止盈」。
 * 題材知識一律放在 Category 裡（ADR-0004）。
 */

// ── 類別 ───────────────────────────────────────────────────────────

export interface Category {
  readonly name: string;
  readonly locator: Locator;
  readonly skeleton: readonly Position[];
  readonly framing: FramingStrategy;
  /** 語音辨識誤轉的專有名詞校正表，例如 FBG → FVG。只用於文字呈現，不參與定位。 */
  readonly glossary: Readonly<Record<string, string>>;
  readonly duration: DurationTarget;
  readonly music: MusicConfig;
}

/**
 * 定位策略。可辨識聯集 —— v1 只有口令一個成員，
 * 日後新增 `deictic` 或 `llm-scan` 是純增量（ADR-0004）。
 */
export type Locator = CueLocator;

export interface CueLocator {
  readonly kind: 'cue';
  /**
   * 決定性偵測器。前綴在 231,715 段同題材語料中僅出現 1 次，
   * 在三支自錄樣本中召回率 100%（ADR-0001）。
   */
  readonly prefix: string;
  /** 前綴後取多少字交給分類器判讀。 */
  readonly proximity: number;
  readonly events: readonly CueEvent[];
}

/**
 * 一種可被錨點標記的事件。`description` 是給分類器讀的自然語言，
 * 不是給程式比對的字串 —— 語音辨識的變體由分類器吸收，不維護白名單。
 */
export interface CueEvent {
  readonly id: string;
  readonly role: AnchorRole;
  readonly description: string;
  /** 僅 role 為 close 時有意義，對應 CONTEXT.md 的「結果」。 */
  readonly outcome?: string;
}

export type AnchorRole = 'open' | 'close';

/**
 * 背景音樂。短影片不帶講者原聲，敘事由文案卡承載，音樂只是底噪。
 * 未指定 `path` 時使用程式生成的底樂 —— 沒有版權持有人、不需要歸屬，
 * 也不會觸發平台的內容比對（「無版權音樂」不等於「不會被認領」）。
 */
export interface MusicConfig {
  readonly path?: string;
  readonly gainDb: number;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
}

// ── 骨架 ───────────────────────────────────────────────────────────

export interface Position {
  readonly id: string;
  readonly source: PositionSource;
  readonly framing: FramingMode;
  /** 播放倍速，省略即原速。原聲已不使用，因此任何位置都可以變速。 */
  readonly speed?: number;
  /** 素材不存在時可消失而非報錯（ADR-0004）。 */
  readonly collapsible: boolean;
}

/**
 * 相對於區段某一端錨點的時間窗口，單位秒；負值代表錨點之前。
 * 引用的是角色而非事件 id —— 骨架不需要知道結束錨點是止盈還是止損。
 */
export interface PositionSource {
  readonly anchor: AnchorRole;
  readonly from: number;
  readonly to: number;
}

export type FramingMode = 'full' | 'roi';
export type FramingStrategy = 'fixed' | 'content-aware';

export interface DurationTarget {
  readonly target: number;
  readonly min: number;
  readonly max: number;
}

// ── 計畫（渲染器的輸入契約）─────────────────────────────────────────

export interface Plan {
  readonly source: PlanSource;
  readonly span: PlanSpan;
  readonly cuts: readonly Cut[];
  readonly cards: readonly Card[];
  readonly metadata: PlanMetadata;
}

export interface PlanSource {
  readonly video: string;
  readonly width: number;
  readonly height: number;
}

export interface PlanSpan {
  readonly index: number;
  readonly openAt: number;
  readonly closeAt: number;
  readonly outcome: string;
}

/** 一個骨架位置實際對應到的長影片時間區間。 */
export interface Cut {
  readonly positionId: string;
  readonly start: number;
  readonly end: number;
  readonly framing: FramingMode;
  readonly speed?: number;
}

export type CardKind = 'title' | 'caption';

/**
 * 畫面上的一張文字卡。沒有人聲，所以敘事全靠這些卡。
 * `start` 與 `end` 是**成品時間軸**上的秒數，不是長影片的時間 ——
 * 文案卡與片段是兩套獨立的時間軸，一張卡可以跨越片段邊界。
 */
export interface Card {
  readonly kind: CardKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface PlanMetadata {
  readonly title: string;
  readonly description: string;
  readonly hashtags: readonly string[];
}
