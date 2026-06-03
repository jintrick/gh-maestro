#!/usr/bin/env node
// check-worker-state.js
// ワーカーペインが入力待ち状態かどうかを判定する
//
// Usage:
//   node check-worker-state.js --worker-name <name> --workspace <path>
//
// 標準出力: "waiting" または "busy"
// 終了コード: 0=waiting, 1=busy, 2=エラー

const { spawnSync } = require('child_process');
const { resolve } = require('path');
const { readFileSync, existsSync } = require('fs');

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const workerName = get('--worker-name');
const workspace  = get('--workspace') ?? process.cwd();

const fail = (msg) => { console.error(`check-worker-state: ${msg}`); process.exit(2); };
if (!workerName) fail('--worker-name が必要です');

const workersJson = resolve(workspace, '.gh-maestro', 'workers.json');
if (!existsSync(workersJson)) fail(`workers.json が見つかりません: ${workersJson}`);

const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
const paneId = workers[workerName];
if (!paneId) fail(`ワーカー "${workerName}" が workers.json に存在しません`);

// ペインのテキストを取得（末尾20行）
const r = spawnSync('wezterm', ['cli', 'get-text', '--pane-id', paneId, '--start-line', '-20'], { encoding: 'utf8' });
if (r.status !== 0) fail(`wezterm get-text 失敗: ${r.stderr}`);

const lines = r.stdout.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
const lastLines = lines.slice(-5);

// 入力待ちの判定: agyのプロンプト文字が末尾行に存在するか
// agy/Gemini CLIは入力待ち時に ❯ または > をプロンプトとして表示する
const WAITING_PATTERNS = [/❯/, /^>/, /^\$/, /\?\s*$/, /:\s*$/];
const isWaiting = lastLines.some(line =>
  WAITING_PATTERNS.some(pat => pat.test(line))
);

if (isWaiting) {
  console.log('waiting');
  process.exit(0);
} else {
  console.log('busy');
  process.exit(1);
}
