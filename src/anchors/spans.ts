import type { Anchor, Category, Span, SourcingWindow } from '../types.ts';

/**
 * 錨點配對成區段，並算出取材窗口。
 */

/**
 * 連續同角色且時間相近的錨點收斂成第一個。
 *
 * 講者會把同一個事件連喊兩次（實測：「那這筆我們就是止盈」後兩秒又說
 * 「這筆止盈，所以 1.27R 我們拿到了」）。
 *
 * **必須有時間窗**：只看「連續同角色」在偵測完整時是對的，但一旦漏掉一個
 * 開始錨點，就會把相隔數分鐘的兩筆交易的結束併成一個，兩筆一起消失。
 * 實測十三分鐘樣本正是如此 —— 05:16 與 10:06 的兩次結束被併成一個，
 * 區段歸零。相隔超過窗口的同角色錨點保留下來，讓它在未配對清單裡現形。
 */
export const REPEAT_WINDOW_SECONDS = 90;

export interface CollapseResult {
  readonly kept: readonly Anchor[];
  /** 被視為重複而丟掉的錨點。丟掉的東西必須看得見。 */
  readonly dropped: readonly Anchor[];
}

export function collapseRepeats(
  anchors: readonly Anchor[],
  windowSeconds: number = REPEAT_WINDOW_SECONDS,
): CollapseResult {
  const kept: Anchor[] = [];
  const dropped: Anchor[] = [];

  for (const anchor of anchors) {
    const previous = kept[kept.length - 1];
    // 比對 eventId 而非只比角色：先部分止盈再全部止盈是兩個不同的事件，
    // 只看角色會把後者當成重複丟掉，結果標成「部分止盈」。
    const isRepeat =
      previous !== undefined &&
      previous.eventId === anchor.eventId &&
      anchor.at - previous.at <= windowSeconds;
    if (isRepeat) {
      dropped.push(anchor);
      continue;
    }
    kept.push(anchor);
  }
  return { kept, dropped };
}

export interface PairingResult {
  readonly pairs: readonly { readonly open: Anchor; readonly close: Anchor }[];
  /** 沒有配到對的錨點 —— 通常代表使用者漏喊，值得讓他看見。 */
  readonly unpaired: readonly Anchor[];
}

/**
 * 依時間順序配對。假設區段互不重疊（一次只持有一筆），
 * 所以配對就是「開始接著結束」的簡單掃描。
 *
 * 開始之後又出現開始、或結束前沒有開始，都代表使用者漏喊了口令。
 * 這種情況把落單的錨點記錄下來而不是猜測配對 —— 猜錯會產出一支看起來
 * 完全正常、卻把甲的進場配乙的結果的短片，使用者不會發現（ADR-0001）。
 */
export function pairAnchors(anchors: readonly Anchor[]): PairingResult {
  const pairs: { open: Anchor; close: Anchor }[] = [];
  const unpaired: Anchor[] = [];
  let pendingOpen: Anchor | undefined;

  for (const anchor of anchors) {
    if (anchor.role === 'open') {
      if (pendingOpen !== undefined) unpaired.push(pendingOpen);
      pendingOpen = anchor;
      continue;
    }
    if (pendingOpen === undefined) {
      unpaired.push(anchor);
      continue;
    }
    pairs.push({ open: pendingOpen, close: anchor });
    pendingOpen = undefined;
  }

  if (pendingOpen !== undefined) unpaired.push(pendingOpen);
  return { pairs, unpaired };
}

/** 骨架往錨點兩側伸出多遠，決定窗口的最大範圍。 */
function skeletonReach(category: Category): { readonly open: number; readonly close: number } {
  let open = 0;
  let close = 0;
  for (const position of category.skeleton) {
    const { anchor, reach } = position.source;
    if (anchor === 'open') open = Math.max(open, reach);
    else close = Math.max(close, reach);
  }
  return { open, close };
}

/**
 * 窗口自錨點向外展開至骨架需要的範圍，但碰到鄰近區段的錨點就截斷，
 * 因此各區段的取材範圍互不重疊。
 */
export function sourcingWindow(
  pair: { readonly open: Anchor; readonly close: Anchor },
  previousCloseAt: number | undefined,
  nextOpenAt: number | undefined,
  category: Category,
  durationSeconds: number,
): SourcingWindow {
  const reach = skeletonReach(category);
  const lowerBound = previousCloseAt ?? 0;
  const upperBound = nextOpenAt ?? durationSeconds;

  return {
    openFrom: Math.max(lowerBound, pair.open.at - reach.open),
    openTo: Math.min(pair.close.at, pair.open.at + reach.open),
    closeFrom: Math.max(pair.open.at, pair.close.at - reach.close),
    closeTo: Math.min(upperBound, pair.close.at + reach.close),
  };
}

export function buildSpans(
  anchors: readonly Anchor[],
  category: Category,
  durationSeconds: number,
): { readonly spans: readonly Span[]; readonly unpaired: readonly Anchor[] } {
  const { kept, dropped } = collapseRepeats(anchors);
  const { pairs, unpaired } = pairAnchors(kept);

  const spans = pairs.map((pair, index) => {
    const previous = pairs[index - 1];
    const next = pairs[index + 1];
    return {
      index: index + 1,
      openAt: pair.open.at,
      closeAt: pair.close.at,
      outcome: pair.close.outcome ?? pair.close.eventId,
      window: sourcingWindow(pair, previous?.close.at, next?.open.at, category, durationSeconds),
    } satisfies Span;
  });

  return { spans, unpaired: [...unpaired, ...dropped] };
}
