'use strict';
// npm test 実行時に --require でプリロードする、テストスイート全体の共通環境設定。
//
// PID registry 等の runtime root（scripts/shared/storage-layout.js の runtimeRoot()）は
// 既定で OS の共有領域（Windows: %LOCALAPPDATA%\gh-maestro、Linux: $XDG_STATE_HOME/gh-maestro）
// を指す。CLIスクリプトを実プロセスとしてサブプロセス起動するテスト（msg-poll.test.js /
// poll-pr.test.js / worker-supervisor.test.js 等）が GH_MAESTRO_RUNTIME_DIR を明示せずに
// 実行すると、テスト用の一時ワークスペースごとに開発機の実 runtime root へ空の
// workspaces/<hash>/ ディレクトリが残留し続ける（一時ワークスペース自体は各テストの
// 後始末で削除されるが、runtime root 側のエントリは削除されないため）。
//
// このプリロードは `node --test` の親プロセス側で1回だけ実行され、以降 fork される
// 各テストファイルの子プロセスへ環境変数として継承されるため、個々のテストファイルが
// 明示的にオーバーライドしない限りテスト専用の一時ディレクトリへ隔離される。
// 個々のテストファイルが（process-lifecycle.test.js のように）独自の
// GH_MAESTRO_RUNTIME_DIR を設定する場合は、そちらが優先される。

const os = require('os');
const path = require('path');
const fs = require('fs');
const { clearWorkerContextEnv } = require('./_spawn-env');

// npm test はワーカーのシェルから起動されることがある。親のワーカー識別・workspace・
// Issue・PRベースをテストプロセスへ残すと、env を省略した実spawnが実環境を向くため、
// 子プロセス用ヘルパーと同じ一覧をテストスイートの入口で中立化する。
clearWorkerContextEnv(process.env);

if (!process.env.GH_MAESTRO_RUNTIME_DIR) {
  const dir = path.join(os.tmpdir(), 'gh-maestro-test-runtime-root-' + process.pid);
  process.env.GH_MAESTRO_RUNTIME_DIR = dir;

  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}

// git はフック（pre-commit / pre-push 等）の実行時に GIT_DIR / GIT_COMMON_DIR /
// GIT_INDEX_FILE / GIT_WORK_TREE / GIT_PREFIX 等を設定する。テストスイートを git フック
// 内から実行した場合、これらは `node --test` の親プロセスから fork される全テストファイル
// と、そこから spawn される子プロセス（git / gh）へそのまま継承される。
//
// 設定されたまま一時リポジトリを扱うテスト（spawnSync('git', ..., { cwd: 一時dir }) で
// git init / commit / remote add を行う fixture や、cwd 依存で gh repo view を呼ぶ
// assistant-watch のテスト等）が走ると、git/gh は cwd の一時リポジトリを無視して
// GIT_DIR が指す実リポジトリ（フックを実行しているリポジトリ）を解決してしまい、
// 「remote origin already exists」・実リポジトリへの意図しない書き込み・実ポーリング
// （assistant-watch の既定 20 分待機）等、想定外の挙動に至る
// （実障害: Issue #282 の pre-push フック内 npm test が GIT_DIR 漏洩でハングした）。
// テストは呼び出し元の git 文脈から独立させる必要があるため、ここで確実に除去する。
for (const key of [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
  'GIT_PREFIX',
]) {
  delete process.env[key];
}
