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
export function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
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
