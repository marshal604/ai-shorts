import { resolve } from 'node:path';

/** 帶值的旗標。解析時必須跳過它們的值，否則值會被當成位置參數。 */
const VALUE_FLAGS = new Set(['--out', '--music']);

export interface CliArgs {
  readonly planPath: string;
  readonly outDir: string;
  /** 覆寫類別設定的背景音樂；未指定時用類別的預設（程式生成的底樂）。 */
  readonly musicPath?: string;
}

/**
 * 解析成功回傳絕對路徑；用法錯誤回傳 null 由呼叫端印說明。
 *
 * 不認得的旗標一律視為用法錯誤而非忽略 —— 靜靜吞掉打錯的旗標，
 * 意味著使用者要等整段編碼跑完，才會發現輸出跑到別的地方去了。
 */
export function parseArgs(argv: readonly string[]): CliArgs | null {
  const positional: string[] = [];
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    // 同時支援 `--out dist` 與 `--out=dist` 兩種寫法。
    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!VALUE_FLAGS.has(name)) return null;

    if (equals >= 0) {
      const inlineValue = arg.slice(equals + 1);
      if (inlineValue.length === 0) return null;
      values.set(name, inlineValue);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined) return null;
    values.set(name, value);
    index += 1;
  }

  const planPath = positional[0];
  if (planPath === undefined) return null;

  const musicPath = values.get('--music');
  const base = {
    planPath: resolve(planPath),
    outDir: resolve(values.get('--out') ?? 'out'),
  };
  return musicPath === undefined ? base : { ...base, musicPath: resolve(musicPath) };
}
