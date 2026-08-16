import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.ts';

describe('命令列參數', () => {
  it('取第一個位置參數當計畫路徑', () => {
    const args = parseArgs(['plan.json']);
    expect(args?.planPath).toBe(resolve('plan.json'));
  });

  it('--out 在計畫路徑之後', () => {
    const args = parseArgs(['plan.json', '--out', '/tmp/shorts']);
    expect(args?.planPath).toBe(resolve('plan.json'));
    expect(args?.outDir).toBe(resolve('/tmp/shorts'));
  });

  it('--out 在計畫路徑之前 —— 旗標的值不可以被當成位置參數', () => {
    const args = parseArgs(['--out', '/tmp/shorts', 'plan.json']);
    expect(args?.planPath).toBe(resolve('plan.json'));
    expect(args?.outDir).toBe(resolve('/tmp/shorts'));
  });

  it('未指定 --out 時預設輸出到 out', () => {
    expect(parseArgs(['plan.json'])?.outDir).toBe(resolve('out'));
  });

  it('沒有計畫路徑就視為用法錯誤', () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(['--out', '/tmp/shorts'])).toBeNull();
  });

  it('--out 後面沒有值就視為用法錯誤，不會吃掉下一個參數', () => {
    expect(parseArgs(['plan.json', '--out'])).toBeNull();
  });

  it('不認得的旗標視為用法錯誤 —— 靜靜吞掉打錯的旗標，使用者要等編碼跑完才發現', () => {
    expect(parseArgs(['--verbose', 'plan.json'])).toBeNull();
    expect(parseArgs(['plan.json', '--ou', '/tmp/x'])).toBeNull();
  });

  it('支援 --out=值 的寫法', () => {
    const args = parseArgs(['plan.json', '--out=/tmp/shorts']);
    expect(args?.outDir).toBe(resolve('/tmp/shorts'));
  });

  it('支援 --music=值 的寫法', () => {
    const args = parseArgs(['plan.json', '--music=/tmp/bed.mp3']);
    expect(args?.musicPath).toBe(resolve('/tmp/bed.mp3'));
  });

  it('--out= 後面空的視為用法錯誤', () => {
    expect(parseArgs(['plan.json', '--out='])).toBeNull();
  });

  it('未指定 --music 時不帶音樂路徑', () => {
    expect(parseArgs(['plan.json'])?.musicPath).toBeUndefined();
  });
});
