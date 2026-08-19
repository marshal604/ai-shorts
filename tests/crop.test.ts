import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { backgroundLevel, detectContentLayout, runsAbove } from '../src/render/crop.ts';

// 從使用者真實的 TradingView 螢幕錄影抽出的灰階幀，縮到 640 寬。
// 用真實素材而非合成圖：死留白會隨時間變動、工具列有細線與圖示，
// 這些都是想像不出來的。
const WIDTH = 640;
const HEIGHT = 358;

function frame(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.gray`, import.meta.url))));
}

describe('背景色偵測', () => {
  it('兩幀取到同一個背景色 —— 螢幕錄影的底色不會變', () => {
    expect(backgroundLevel(frame('chart-0140'))).toBe(backgroundLevel(frame('chart-0044')));
  });

  it('背景是深色，符合深色主題的圖表', () => {
    expect(backgroundLevel(frame('chart-0140'))).toBeLessThan(80);
  });
});

describe('連續區段偵測', () => {
  it('把高於門檻的連續段落找出來', () => {
    expect(runsAbove([0, 1, 1, 1, 0, 1, 1, 1], 0.5, 3)).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 8 },
    ]);
  });

  it('短於下限的段落被當成雜訊濾掉', () => {
    expect(runsAbove([0, 1, 0, 1, 1, 1, 1], 0.5, 3)).toEqual([{ from: 3, to: 7 }]);
  });

  it('沒有任何內容時回傳空陣列', () => {
    expect(runsAbove([0, 0, 0], 0.5, 2)).toEqual([]);
  });
});

describe('內容分佈偵測', () => {
  it('排除頂部工具列 —— 那不是內容', () => {
    for (const name of ['chart-0140', 'chart-0044']) {
      const layout = detectContentLayout(frame(name), WIDTH, HEIGHT);
      expect(layout.vertical.from).toBeGreaterThan(0);
      expect(layout.vertical.from / HEIGHT).toBeLessThan(0.1);
    }
  });

  it('主體結束在 K 棒結束的地方，死留白不算內容', () => {
    // 這一幀的 K 棒大約在畫面三分之一處就結束，右邊全是還沒走到的空白。
    // 舊的密度判準量出 0.78 —— 那不是 K 棒，是穿過死留白的 fib 水平虛線
    // 與 session 垂直虛線；它們讓欄密度永遠不歸零，整片留白都被當成內容。
    const layout = detectContentLayout(frame('chart-0140'), WIDTH, HEIGHT);
    expect(layout.body.to / WIDTH).toBeGreaterThan(0.2);
    expect(layout.body.to / WIDTH).toBeLessThan(0.45);
  });

  it('主體與右側軸之間有間隙時，軸被單獨切出來', () => {
    const layout = detectContentLayout(frame('chart-0044'), WIDTH, HEIGHT);
    expect(layout.axis).toBeDefined();
    expect(layout.axis!.from).toBeGreaterThan(layout.body.to);
    expect(layout.axis!.to / WIDTH).toBeGreaterThan(0.95);
  });

  it('主體與軸之間沒有間隙時，軸還是切得出來', () => {
    // 這一幀的虛線把主體與軸連成同一個密度區段，靠「找間隙」永遠切不開。
    // 軸自己的特徵才是可靠的：一整排右對齊的價格標籤，欄密度高一個量級。
    const layout = detectContentLayout(frame('chart-0140'), WIDTH, HEIGHT);
    expect(layout.axis).toBeDefined();
    expect(layout.axis!.from / WIDTH).toBeGreaterThan(0.9);
    expect(layout.axis!.to / WIDTH).toBeGreaterThan(0.95);
  });

  it('只有虛線的欄不算主體 —— 虛線沒有垂直結構', () => {
    // 左半：整根貫穿的直線（像 K 棒的實體加影線）。
    // 右半：只有幾條水平線經過（像死留白裡的 fib 線），垂直方向永遠只有一列。
    const gray = new Uint8Array(WIDTH * HEIGHT);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const onBar = x < WIDTH / 2 && x % 4 === 0 && y > 40 && y < 300;
        const onFibLine = y % 60 === 0;
        if (onBar || onFibLine) gray[y * WIDTH + x] = 200;
      }
    }
    const layout = detectContentLayout(gray, WIDTH, HEIGHT);
    expect(layout.body.to).toBeLessThanOrEqual(WIDTH / 2 + 8);
  });

  it('兩幀的主體右緣不同 —— 這正是固定矩形不可行的原因', () => {
    // 收緊之後兩幀相差 32 欄（5%）。比舊判準的差距小，因為那時的差距大半
    // 來自死留白量到哪裡，而不是 K 棒實際畫到哪裡。
    const a = detectContentLayout(frame('chart-0140'), WIDTH, HEIGHT);
    const b = detectContentLayout(frame('chart-0044'), WIDTH, HEIGHT);
    expect(Math.abs(a.body.to - b.body.to)).toBeGreaterThan(WIDTH * 0.03);
  });

  it('偵測範圍不會超出畫面', () => {
    for (const name of ['chart-0140', 'chart-0044']) {
      const layout = detectContentLayout(frame(name), WIDTH, HEIGHT);
      expect(layout.body.from).toBeGreaterThanOrEqual(0);
      expect(layout.body.to).toBeLessThanOrEqual(WIDTH);
      expect(layout.vertical.to).toBeLessThanOrEqual(HEIGHT);
      if (layout.axis !== undefined) expect(layout.axis.to).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('全黑的畫面不會炸開，回傳整幅範圍', () => {
    const blank = new Uint8Array(WIDTH * HEIGHT);
    const layout = detectContentLayout(blank, WIDTH, HEIGHT);
    expect(layout.body).toEqual({ from: 0, to: WIDTH });
    expect(layout.vertical).toEqual({ from: 0, to: HEIGHT });
  });

  it('結果是決定性的 —— 同一幀跑兩次完全相同', () => {
    const first = detectContentLayout(frame('chart-0140'), WIDTH, HEIGHT);
    const second = detectContentLayout(frame('chart-0140'), WIDTH, HEIGHT);
    expect(first).toEqual(second);
  });
});
