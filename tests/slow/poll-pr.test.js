'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

// poll-pr.js は require.main===module 時のみCLIを実行するため、
// getPrBaseBranch/formatBaseBranchMismatch/spawnPollReviews は純粋関数としてrequireで検証する。
// spawnPollReviews は child-process.js の spawnSync をモックし、実プロセスを0個spawnする
// CLI起動時の即時エラー終了パス
// （--help）のみ、ループに入らず即exitすることを利用して実プロセスをspawnSyncで同期実行する
// （detachedポーラーは起動しない）。
//
// 観点選定（旧--review-aspects auto/明示リスト）は廃止した。ファイルパターンでの
// 機械的な観点自動判定が一部の観点だけに絞り込んでしまい他の観点のレビューが丸ごと
// 欠落する実障害があったため、poll-pr.jsは常にReview Managerをheavyモード（全観点）で
// 起動するだけにし、観点を絞り込むかどうかの判断はReview Manager自身（実際のdiffを
// 見た上での判断）に委ねる（skills/gh-maestro-reviewer/SKILL.md参照）。

const pollPrPath = require.resolve('../../scripts/poll-pr');

/**
 * scripts/shared/child-process.js の spawnSync をモックした状態で poll-pr.js を再ロードする。
 * @param {Function} spawnSyncImpl (cmd, args, opts) => result
 */
function loadModule(spawnSyncImpl) {
  const calls = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawnSyncImpl ? spawnSyncImpl(cmd, args, opts) : { status: 0, stdout: '' };
  };

  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: { spawn: () => { throw new Error('spawn should not be called in this test'); }, spawnSync: fakeSpawnSync, execSync: () => '' },
  };

  delete require.cache[pollPrPath];
  const mod = require(pollPrPath);

  delete require.cache[childProcessPath];
  return { mod, calls };
}

// ── spawnPollReviews ─────────────────────────────────────────────────────





// ── getPrBaseBranch ───────────────────────────────────────────────────────




// ── getPrState（Issue #289: poll-reviews 終了後の続行判断用） ─────────────



// ── resolvePostReviewDecision（Issue #289: CLOSED → findPR 復帰） ────────────
const { resolvePostReviewDecision } = require('../../scripts/poll-pr');





// ── formatBaseBranchMismatch ──────────────────────────────────────────────





// ── CLI起動時の即時エラー終了パス（ループに入る前にexitするため実プロセスspawn可） ──

test('CLI --help exits 0 and no longer mentions --review-aspects（廃止した観点自動判定フラグの回帰防止）', () => {
  const result = spawnSync(process.execPath, [pollPrPath, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /--review-aspects/);
  // --no-review-manager（レビューを蒸し返さずに監視だけ再開する再起動用フラグ）が文書化されていること
  assert.match(result.stdout, /--no-review-manager/);
});

test('CLI exits non-zero when <ISSUE> is omitted', () => {
  const result = spawnSync(process.execPath, [pollPrPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage/);
});
