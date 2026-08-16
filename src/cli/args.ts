import { resolve } from 'node:path';

/** 帶值的旗標。解析時必須跳過它們的值，否則值會被當成位置參數。 */
const VALUE_FLAGS = new Set(['--out']);

export interface CliArgs {
  readonly planPath: string;
  readonly outDir: string;
}

/** 解析成功回傳絕對路徑；用法錯誤回傳 null 由呼叫端印說明。 */
export function parseArgs(argv: readonly string[]): CliArgs | null {
  const positional: string[] = [];
  let outDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) return null;
      if (arg === '--out') outDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }

  const planPath = positional[0];
  if (planPath === undefined) return null;

  return { planPath: resolve(planPath), outDir: resolve(outDir ?? 'out') };
}
