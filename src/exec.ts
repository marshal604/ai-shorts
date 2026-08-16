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
      child.stdin?.end(options.input);
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
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
