#!/usr/bin/env node
// view-file.js
// 右ペインにファイルをbatで表示する。ペインを再利用するので呼ぶたびに新規作成しない。
//
// Usage:
//   node view-file.js <filepath> [--workspace <path>]

const { spawnSync } = require('child_process');
const { resolve } = require('path');
const { mkdirSync } = require('fs');

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

// Git Bash の POSIX パス（/tmp/foo, /c/Users/...）を Node.js が扱える Windows パスに変換する。
// cygpath が使えればそれを優先し、なければ汎用フォールバックで処理する。
const toWinPath = (p) => {
  if (!p.startsWith('/')) return p;
  const r = spawnSync('cygpath', ['-w', p], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  // /c/Users/... → C:\Users\...
  const drive = p.match(/^\/([a-zA-Z])(\/|$)/);
  if (drive) return `${drive[1].toUpperCase()}:${p.slice(2).replace(/\//g, '\\')}`;
  // /tmp/... → %TEMP%\...
  const temp = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
  if (p.startsWith('/tmp')) return p.replace('/tmp', temp).replace(/\//g, '\\');
  return p;
};

const absPath = resolve(toWinPath(filePath));
const ghMaestroDir = resolve(toWinPath(workspace), '.gh-maestro');

const escapedPath = absPath.replace(/\\/g, '/').replace(/"/g, '\\"');

// --- bat の有無を確認してビューアコマンドを決定 ---
const hasBat = spawnSync('bat', ['--version'], { encoding: 'utf8' }).status === 0;
const viewCmd = hasBat ? `bat --paging=always --style=plain --theme=ansi "${escapedPath}"` : `cat "${escapedPath}"`;

// --- viewer pane を探す ---
// ファイルへの ID 保存は行わない。WezTerm は pane ID を再利用するため、
// 保存した ID が別ペインを指す可能性を排除できない。
// 代わりに「オーケストレーターの右隣 = viewer pane」という空間的関係で毎回動的に取得する。
const getRightPane = () => {
  const r = spawnSync('wezterm', ['cli', 'get-pane-direction', '--pane-id', orchPaneId, 'Right'], { encoding: 'utf8' });
  return (r.status === 0 && r.stdout.trim()) ? r.stdout.trim() : null;
};

const send = (paneId, text, noPaste = false) => {
  const args = ['cli', 'send-text', '--pane-id', paneId];
  if (noPaste) args.push('--no-paste');
  args.push(text);
  spawnSync('wezterm', args, { stdio: 'inherit' });
};

let viewerPaneId = getRightPane();

if (viewerPaneId) {
  // ペイン再利用: bat/lessが動いていれば q で終了、シェルにいれば q コマンドが走る（エラーは無害）
  send(viewerPaneId, 'q', true);
  send(viewerPaneId, '\r', true);
  send(viewerPaneId, viewCmd);
  send(viewerPaneId, '\r', true);
} else {
  // 新規作成
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

  send(viewerPaneId, viewCmd);
  send(viewerPaneId, '\r', true);
}
