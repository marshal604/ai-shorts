import { spawn } from 'node:child_process';
import { ExternalToolError } from './errors.ts';

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 執行外部工具並等待完成。
 * 失敗時拋出具型別錯誤並附上 stderr 尾段 —— ffmpeg 的錯誤訊息全在那裡。
 */
export interface RunOptions {
  /** 要寫進子行程 stdin 的內容。長提示詞放 argv 會撞到長度限制。 */
  readonly input?: string;
  /** 要從子行程環境中移除的變數名稱。 */
  readonly unsetEnv?: readonly string[];
}

function childEnv(unset: readonly string[] | undefined): NodeJS.ProcessEnv | undefined {
  if (unset === undefined || unset.length === 0) return undefined;
  const env = { ...process.env };
  for (const name of unset) delete env[name];
  return env;
}

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = childEnv(options.unsetEnv);
    const child = spawn(command, [...args], {
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(env === undefined ? {} : { env }),
    });

    if (options.input !== undefined) {
      // 子行程可能在讀完之前就結束；沒有這個監聽器，EPIPE 會變成未處理例外。
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input);
    }

    // 一定要設編碼，不能逐塊 toString()：多位元組字元跨越塊邊界時，
    // 每塊各自解碼會把它切成兩個替代字元。中文內容幾乎必然踩到。
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (cause: Error) => {
      reject(new ExternalToolError(command, null, `無法執行 ${command}：${cause.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.trim().split('\n').slice(-12).join('\n');
      reject(new ExternalToolError(command, code, `${command} 以 ${code} 結束：\n${tail}`));
    });
  });
}

/**
 * 與 run 相同，但把 stdout 當二進位收。
 *
 * run 會用 toString() 逐塊轉字串，像素資料經過 UTF-8 解碼會被破壞 ——
 * 無效位元組被換成替代字元，長度也對不上。
 */
export function runBinary(
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: Buffer; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (cause: Error) => {
      reject(new ExternalToolError(command, null, `無法執行 ${command}：${cause.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(chunks), stderr });
        return;
      }
      const tail = stderr.trim().split('\n').slice(-12).join('\n');
      reject(new ExternalToolError(command, code, `${command} 以 ${code} 結束：\n${tail}`));
    });
  });
}
