'use strict';
// npm test 実行時に --require でプリロードする、テストスイート全体の共通環境設定。
//
// PID registry 等の runtime root（scripts/shared/storage-layout.js の runtimeRoot()）は
// 既定で OS の共有領域（Windows: %LOCALAPPDATA%\gh-maestro、Linux: $XDG_STATE_HOME/gh-maestro）
// を指す。CLIスクリプトを実プロセスとしてサブプロセス起動するテスト（msg-poll.test.js /
// poll-pr.test.js / inbox-supervisor.test.js 等）が GH_MAESTRO_RUNTIME_DIR を明示せずに
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

if (!process.env.GH_MAESTRO_RUNTIME_DIR) {
  const dir = path.join(os.tmpdir(), 'gh-maestro-test-runtime-root-' + process.pid);
  process.env.GH_MAESTRO_RUNTIME_DIR = dir;

  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
}
