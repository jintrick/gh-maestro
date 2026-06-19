#!/usr/bin/env node
// view-file.js
// 右ペインにファイルをbatで表示する。ペインを再利用するので呼ぶたびに新規作成しない。
//
// Usage:
//   node view-file.js <filepath> [--workspace <path>]

const { spawnSync } = require('child_process');
const { resolve } = require('path');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const { randomUUID } = require('crypto');
const os = require('os');

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

// viewer pane の同定は pane ID ではなく UUID-named cwd で行う。
// pane ID は WezTerm 再起動後に再利用される可能性があり一意性が保証されない。
// 代わりに split-pane --cwd <uuid-dir> で起動し、wezterm cli list の cwd フィールドで検索する。
// UUID は crypto.randomUUID() で生成するため真に一意。
const viewerUuidFile = resolve(ghMaestroDir, `viewer-uuid-${orchPaneId}`);

const escapedPath = absPath.replace(/\\/g, '/').replace(/"/g, '\\"');

// --- bat の有無を確認してビューアコマンドを決定 ---
const hasBat = spawnSync('bat', ['--version'], { encoding: 'utf8' }).status === 0;
const viewCmd = hasBat ? `bat --paging=always --style=plain --theme=ansi "${escapedPath}"` : `cat "${escapedPath}"`;

// --- wezterm list から cwd で viewer pane を探す ---
const findViewerByCwd = (uuid) => {
  const r = spawnSync('wezterm', ['cli', 'list', '--format', 'json'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  let panes;
  try { panes = JSON.parse(r.stdout); } catch { return null; }
  const marker = `ghm-viewer-${uuid}`;
  const found = panes.find(p => (p.cwd || '').replace(/\\/g, '/').includes(marker));
  return found ? String(found.pane_id) : null;
};

const send = (paneId, text, noPaste = false) => {
  const args = ['cli', 'send-text', '--pane-id', paneId];
  if (noPaste) args.push('--no-paste');
  args.push(text);
  spawnSync('wezterm', args, { stdio: 'inherit' });
};

// --- 既存 viewer pane を UUID で探す ---
let viewerPaneId = null;
if (existsSync(viewerUuidFile)) {
  const uuid = readFileSync(viewerUuidFile, 'utf8').trim();
  viewerPaneId = findViewerByCwd(uuid);
}

if (viewerPaneId) {
  // ペイン再利用: bat/lessが動いていれば q で終了、シェルにいれば q コマンドが走る（エラーは無害）
  send(viewerPaneId, 'q', true);
  send(viewerPaneId, '\r', true);
  send(viewerPaneId, viewCmd);
  send(viewerPaneId, '\r', true);
} else {
  // 新規作成: uuid-named cwd で split し、uuid をファイルに保存
  mkdirSync(ghMaestroDir, { recursive: true });

  const uuid = randomUUID();
  const viewerCwd = resolve(os.tmpdir(), `ghm-viewer-${uuid}`);
  mkdirSync(viewerCwd, { recursive: true });

  const split = spawnSync('wezterm', [
    'cli', 'split-pane',
    '--right', '--percent', '45',
    '--pane-id', orchPaneId,
    '--cwd', viewerCwd,
  ], { encoding: 'utf8' });

  if (split.status !== 0) {
    console.error(`view-file: ペイン作成失敗: ${split.stderr.trim()}`);
    process.exit(1);
  }

  viewerPaneId = split.stdout.trim();
  writeFileSync(viewerUuidFile, uuid, 'utf8');

  send(viewerPaneId, viewCmd);
  send(viewerPaneId, '\r', true);
}
