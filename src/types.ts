/**
 * 共用資料模型。詞彙定義見 CONTEXT.md，決策依據見 docs/adr/。
 *
 * 引擎只認得這裡的抽象概念（錨點、區段、骨架位置），不認得「進場」或「止盈」。
 * 題材知識一律放在 Category 裡（ADR-0004）。
 */

// ── 類別 ───────────────────────────────────────────────────────────

export interface Category {
  readonly name: string;
  readonly vocabulary: EventVocabulary;
  readonly skeleton: readonly Position[];
  /**
   * 語音辨識誤轉的專有名詞提示，例如 FBG → FVG。
   * 是給校正階段的提示而非窮舉表 —— 實測校正會抓到不在表裡的錯誤。
   */
  readonly glossary: Readonly<Record<string, string>>;
  /**
   * 長度目標。是**軟性**的：內容講完、節奏順就好，不強制截斷 ——
   * 硬性上限會為了湊秒數而砍掉還沒講完的話。
   */
  readonly duration: DurationTarget;
  readonly music: MusicConfig;
}

/**
 * 事件詞彙表：這個題材有哪些值得標記的事件。
 *
 * 曾經還帶著前綴字串與比對參數，用來在逐字稿上做決定性的偵測。
 * 來源準備階段改為依語意標記之後那些都不再需要 —— 講者不必說出固定字眼，
 * 事件由描述判斷（ADR-0001）。
 */
export interface EventVocabulary {
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
  /**
   * 這個位置的文案卡要傳達什麼，用自然語言寫給規劃器讀。
   * 沒有人聲，卡就是敘事本身 —— 每個位置該講什麼是題材知識，屬於類別。
   */
  readonly cardBrief: string;
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

// ── 逐字稿 ─────────────────────────────────────────────────────────

export interface Transcript {
  readonly source: TranscriptSource;
  readonly language: string;
  readonly segments: readonly TranscriptSegment[];
  /**
   * 來源準備階段標記出來的事件。
   *
   * 校正階段本來就要讀完整份逐字稿，讓它順便標記事件的邊際成本是零 ——
   * 這也讓講者不必逐字照喊固定口令（ADR-0001）。
   */
  readonly events?: readonly MarkedEvent[];
}

export interface MarkedEvent {
  readonly segmentIndex: number;
  readonly eventId: string;
  /** 標記所依據的原句，讓使用者能判斷標對了沒。 */
  readonly quote: string;
}

export interface TranscriptSource {
  readonly video: string;
  readonly durationSeconds: number;
  readonly engine: string;
}

/** 段落邊界是語音停頓，不是閱讀單位 —— 不可以拿來當比對或斷行的單位。 */
export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

// ── 錨點與區段 ─────────────────────────────────────────────────────

export interface AnchorDocument {
  readonly source: TranscriptSource;
  readonly anchors: readonly Anchor[];
  readonly spans: readonly Span[];
  /** 無法配對的錨點，保留下來讓使用者看得見自己漏喊了什麼。 */
  readonly unpaired: readonly Anchor[];
}

export interface Anchor {
  readonly at: number;
  readonly role: AnchorRole;
  readonly eventId: string;
  readonly outcome?: string;
  /** 前綴附近的原文，讓使用者能判斷分類對不對。 */
  readonly excerpt: string;
}

export interface Span {
  readonly index: number;
  readonly openAt: number;
  readonly closeAt: number;
  readonly outcome: string;
  readonly window: SourcingWindow;
}

/** 實際會被讀取逐字稿的範圍，碰到鄰近區段的錨點就截斷。 */
export interface SourcingWindow {
  readonly openFrom: number;
  readonly openTo: number;
  readonly closeFrom: number;
  readonly closeTo: number;
}
