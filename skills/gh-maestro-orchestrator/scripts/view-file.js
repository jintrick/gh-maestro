#!/usr/bin/env node
// view-file.js
// 右ペインにファイルをbatで表示する。ペインを再利用するので呼ぶたびに新規作成しない。
//
// Usage:
//   node view-file.js <filepath> [--workspace <path>]

const { spawnSync } = require('child_process');
const { resolve } = require('path');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');

// --- 引数パース ---
const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] ?? null : null; };

const filePath = argv.find(a => !a.startsWith('--'));
const workspace = get('--workspace') ?? process.cwd();

if (!filePath) {
  console.error('Usage: node view-file.js <filepath> [--workspace <path>]');
  process.exit(1);
}

const orchPaneId = process.env.WEZTERM_PANE;
if (!orchPaneId) {
  console.error('view-file: WEZTERM_PANE が設定されていません');
  process.exit(1);
}

const absPath = resolve(filePath);
const ghMaestroDir = resolve(workspace, '.gh-maestro');
const viewerPaneFile = resolve(ghMaestroDir, 'viewer-pane');

// --- アクティブなペインID一覧を取得 ---
const getAlivePaneIds = () => {
  const r = spawnSync('wezterm', ['cli', 'list', '--format', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) return new Set();
  try {
    return new Set(JSON.parse(r.stdout).map(p => String(p.pane_id)));
  } catch {
    return new Set();
  }
};

const escapedPath = absPath.replace(/"/g, '\\"');

// --- bat の有無を確認してビューアコマンドを決定 ---
const hasBat = spawnSync('bat', ['--version'], { encoding: 'utf8' }).status === 0;
const viewCmd = hasBat ? `bat --paging=always "${escapedPath}"` : `cat "${escapedPath}"`;

// --- 既存ビューアペインを確認 ---
let viewerPaneId = null;
if (existsSync(viewerPaneFile)) {
  const stored = readFileSync(viewerPaneFile, 'utf8').trim();
  if (getAlivePaneIds().has(stored)) {
    viewerPaneId = stored;
  }
}

const send = (text, noPaste = false) => {
  const args = ['cli', 'send-text', '--pane-id', viewerPaneId];
  if (noPaste) args.push('--no-paste');
  args.push(text);
  spawnSync('wezterm', args, { stdio: 'inherit' });
};

if (viewerPaneId) {
  // ペイン再利用: bat/lessが動いていれば q で終了、シェルにいれば q コマンドが走る（エラーは無害）
  send('q', true);
  send('\r', true);
  send(viewCmd);
  send('\r', true);
} else {
  // 新規作成: シェルを起動してペインIDを記録
  mkdirSync(ghMaestroDir, { recursive: true });

  const split = spawnSync('wezterm', [
    'cli', 'split-pane',
    '--right', '--percent', '45',
    '--pane-id', orchPaneId,
  ], { encoding: 'utf8' });

  if (split.status !== 0) {
    console.error(`view-file: ペイン作成失敗: ${split.stderr.trim()}`);
    process.exit(1);
  }

  viewerPaneId = split.stdout.trim();
  writeFileSync(viewerPaneFile, viewerPaneId, 'utf8');

  send(viewCmd);
  send('\r', true);
}
