#!/usr/bin/env node
// 薄殼：把參數轉交給 tsx 執行的 CLI 進入點。
//
// 刻意不覆寫 cwd —— CLI 會把相對路徑解析到 process.cwd()，
// 若切到套件目錄，使用者傳的相對路徑就會解析到錯的地方。
// 因此改為直接指向套件內的 tsx，而不是靠 cwd 讓 npx 找到它。
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(
  resolve(root, 'node_modules/.bin/tsx'),
  [resolve(root, 'src/cli/render.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
