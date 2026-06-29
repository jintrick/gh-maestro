#!/usr/bin/env node
// start-review.js
// レビュアー（run-review.js）をバックグラウンドで起動する唯一の手段。
// poll-pr.js が PR 検出時に呼ぶほか、orchestrator が単独で起動・再起動するためにも使う。
//
// Usage: node start-review.js <PR> <REPO> <WORKSPACE>
// 標準出力:
//   REVIEW_STARTED:<PR>          — レビュアーを新規起動した
//   REVIEW_ALREADY_RUNNING:<PR>  — 既にロックが存在し起動済み（多重起動を防いだ）
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 多重起動を防ぐロックを取り、run-review.js をデタッチ起動する。
// ロックは run-review.js が終了時に自分で削除する（このスクリプトは作るだけ）。
// 戻り値: 'REVIEW_STARTED' | 'REVIEW_ALREADY_RUNNING'
function startReview(pr, repo, workspace) {
  const ghDir = path.join(workspace, '.gh-maestro');
  const lockFile = path.join(ghDir, `review-${pr}.running`);
  fs.mkdirSync(ghDir, { recursive: true });

  if (fs.existsSync(lockFile)) return 'REVIEW_ALREADY_RUNNING';

  fs.writeFileSync(lockFile, String(process.pid));
  const logFd = fs.openSync(path.join(ghDir, `review-${pr}.log`), 'a');
  const child = spawn('node', [path.join(__dirname, 'run-review.js'), pr, repo, workspace], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  // 起動自体に失敗した場合（node 不在等）はロックが残らないよう除去する。
  child.on('error', () => { try { fs.unlinkSync(lockFile); } catch {} });
  child.unref();
  fs.closeSync(logFd);
  return 'REVIEW_STARTED';
}

module.exports = { startReview };

if (require.main === module) {
  const [,, pr, repo, workspace] = process.argv;
  if (!pr || !repo || !workspace) {
    console.error('Usage: start-review.js <PR> <REPO> <WORKSPACE>');
    process.exit(1);
  }
  const status = startReview(pr, repo, workspace);
  process.stdout.write(`${status}:${pr}\n`);
}
