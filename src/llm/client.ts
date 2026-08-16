import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExternalToolError } from '../errors.ts';
import { run } from '../exec.ts';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';

export interface AskOptions {
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens: number;
  /** 快取目錄。同樣的輸入重跑不再發出請求，也不再計費。 */
  readonly cacheDir: string;
}

/**
 * 以輸入雜湊為 key 的磁碟快取。
 *
 * 這是「同一支長影片重跑必須產出相同結果」的實作基礎 —— 不倚賴 API 的
 * temperature 保證。也讓測試不需要網路或 mock 框架：預先把快取內容放好即可。
 */
function cacheKey(options: AskOptions): string {
  return createHash('sha256')
    .update(JSON.stringify({ model: MODEL, system: options.system, prompt: options.prompt }))
    .digest('hex')
    .slice(0, 32);
}

async function readCache(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

interface AnthropicResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
}

/**
 * 兩條路：有 Console 發的 API 金鑰就直接打 HTTP API，沒有就退回本機的
 * `claude` CLI（用使用者既有的登入）。
 *
 * `sk-ant-oat01-` 開頭的是 Claude Code 的 OAuth token，**不能**用於原生 API ——
 * 它會通過長度檢查卻在送出時得到 401，所以要靠前綴分辨而不是靠有沒有值。
 *
 * 成本差距很大：HTTP API 一次約 0.003 美元，CLI 一次約 0.10 美元
 * （每次都載入 Claude Code 的系統提示）。
 */
function consoleApiKey(): string | null {
  const key = process.env['ANTHROPIC_API_KEY'];
  return key !== undefined && key.startsWith('sk-ant-api') ? key : null;
}

/** 退路：用本機已登入的 claude CLI。回應包在 JSON 信封的 result 欄位裡。 */
async function requestViaCli(options: AskOptions): Promise<string> {
  const { stdout } = await run(
    'claude',
    ['-p', '--model', 'sonnet', '--output-format', 'json'],
    {
      input: `${options.system}\n\n${options.prompt}`,
      // OAuth token 存在時會蓋掉 CLI 自己的 claude.ai 登入，導致它直接失敗。
      unsetEnv: ['ANTHROPIC_API_KEY'],
    },
  );
  const envelope = JSON.parse(stdout) as { readonly result?: unknown; readonly is_error?: boolean };
  if (envelope.is_error === true || typeof envelope.result !== 'string') {
    throw new ExternalToolError('claude', null, `CLI 回應無法解析：${stdout.slice(0, 300)}`);
  }
  return envelope.result;
}

async function request(options: AskOptions): Promise<string> {
  const apiKey = consoleApiKey();
  if (apiKey === null) return requestViaCli(options);

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: options.maxTokens,
      temperature: 0,
      system: options.system,
      messages: [{ role: 'user', content: options.prompt }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new ExternalToolError('anthropic', response.status, `API 回應 ${response.status}：${detail.slice(0, 400)}`);
  }

  const body = (await response.json()) as AnthropicResponse;
  const text = (body.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  if (text.length === 0) {
    throw new ExternalToolError('anthropic', null, 'API 回應沒有文字內容');
  }
  return text;
}

export interface AskResult {
  readonly text: string;
  readonly fromCache: boolean;
}

export async function ask(options: AskOptions): Promise<AskResult> {
  await mkdir(options.cacheDir, { recursive: true });
  const path = join(options.cacheDir, `${cacheKey(options)}.txt`);

  const cached = await readCache(path);
  if (cached !== null) return { text: cached, fromCache: true };

  const text = await request(options);
  await writeFile(path, text, 'utf8');
  return { text, fromCache: false };
}

/**
 * 模型即使被要求只輸出 JSON，仍可能包上程式碼圍籬或前後多幾個字。
 * 取第一個 `{`／`[` 到最後一個對應收尾之間的內容再解析。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.search(/[[{]/);
  if (start < 0) throw new ExternalToolError('anthropic', null, `回應中找不到 JSON：${trimmed.slice(0, 200)}`);

  const opening = trimmed[start];
  const closing = opening === '[' ? ']' : '}';
  const end = trimmed.lastIndexOf(closing);
  if (end <= start) throw new ExternalToolError('anthropic', null, `JSON 不完整：${trimmed.slice(0, 200)}`);

  return JSON.parse(trimmed.slice(start, end + 1));
}
