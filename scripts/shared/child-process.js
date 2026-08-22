'use strict';
// child_process ラッパー
// Windows では spawn / spawnSync / execSync に自動的に windowsHide: true を注入する。
// これにより子プロセス生成時のコンソールウィンドウポップアップを防止する。
//
// さらに git を実行する際は、環境変数に注入されたリポジトリローカルな GIT_* を除去してから
// spawn する（Issue #283）。git フック（pre-push / pre-commit 等）は実行時に GIT_DIR 等を
// フック環境へ設定し、GIT_DIR は spawnSync の cwd 指定より優先されてリポジトリ発見を
// 上書きする。共有ラッパー経由の全 git 呼び出しで除去することで、テスト（バイパス不要で
// 既存テストが無改変のまま通る）と本番の両方で「cwd が正」（cwd 基準のリポジトリ発見）を
// 保証する。

const { spawn: _spawn, spawnSync: _spawnSync, execSync: _execSync } = require('child_process');
const path = require('path');

// リポジトリの「位置」を決める git 環境変数。これらが残ったまま git を spawn すると
// cwd を無視して実リポジトリへ操作が向く。`git rev-parse --local-env-vars` の一覧から、
// 位置と無関係な設定変数（GIT_CONFIG / GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT）は
// 意図的に除外する。呼び出し元やCI環境が safe.directory 等を渡している場合に、
// gh-maestro の git 呼び出しだけがその設定を失うのを避けるため。加えて
// GIT_QUARANTINE_PATH（--local-env-vars には含まれないがフックが注入する）も除去する。
const GIT_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_QUARANTINE_PATH',
];

const injectHide = (opts) =>
  process.platform === 'win32' ? { windowsHide: true, ...opts } : opts;

// spawn / spawnSync は実行ファイル名で判定する（Windows の実体は git.exe、環境によっては git.cmd）。
const isGitExecutable = (cmd) => {
  const base = path.basename(String(cmd)).toLowerCase();
  return base === 'git' || base === 'git.exe' || base === 'git.cmd';
};

// execSync はシェルコマンド文字列を取るため、先頭単語が git かどうかで判定する。
const isGitCommandString = (cmd) => /^\s*git(?:\.exe|\.cmd)?(?:\s|$)/i.test(String(cmd));

// opts.env があればそれを基準に、無ければ process.env を基準に、GIT_* だけを除いた env を作る。
// GIT_* を確実に除去するには spawn の env 継承に任せられないため、env を明示的に渡す。
const stripGitEnv = (opts) => {
  const env = { ...(opts && opts.env ? opts.env : process.env) };
  for (const key of GIT_LOCAL_ENV_VARS) delete env[key];
  return env;
};

const sanitizeOpts = (opts, isGit) => {
  const injected = injectHide(opts);
  if (!isGit) return injected;
  return { ...injected, env: stripGitEnv(injected) };
};

const spawn    = (cmd, args, opts)  => _spawn(cmd, args, sanitizeOpts(opts, isGitExecutable(cmd)));
const spawnSync = (cmd, args, opts) => _spawnSync(cmd, args, sanitizeOpts(opts, isGitExecutable(cmd)));
const execSync  = (cmd, opts)       => _execSync(cmd, sanitizeOpts(opts, isGitCommandString(cmd)));

module.exports = { spawn, spawnSync, execSync };
