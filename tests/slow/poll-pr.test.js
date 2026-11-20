'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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

test('claimReviewManagerLaunch: 同時claimでも同一PRを取得できるプロセスは1つだけ', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-poll-pr-concurrent-'));
  const barrier = path.join(workspace, 'claim.start');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  const childScript = `
    const fs = require('fs');
    const { claimReviewManagerLaunch } = require(${JSON.stringify(pollPrPath)});
    const [workspace, pr, barrier] = process.argv.slice(1);
    const waitForBarrier = () => {
      if (!fs.existsSync(barrier)) return setTimeout(waitForBarrier, 1);
      try {
        process.stdout.write(JSON.stringify(claimReviewManagerLaunch(workspace, pr)));
      } catch (error) {
        process.stderr.write(error.stack || String(error));
        process.exitCode = 1;
      }
    };
    waitForBarrier();
  `;
  const children = [1, 2].map(() => spawn(process.execPath, [
    '-e', childScript, workspace, '42', barrier,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const waitForSpawn = children.map((child) => new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  }));

  try {
    await Promise.all(waitForSpawn);
    fs.writeFileSync(barrier, 'go', 'utf8');
    const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) return reject(new Error(`claim child exited ${code}: ${stderr}`));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`${error.message}: ${stdout}`)); }
      });
    })));

    assert.equal(results.filter((result) => result.claimed).length, 1);
    assert.equal(results.filter((result) => !result.claimed).length, 1);
    const claimPath = path.join(workspace, '.gh-maestro', 'records', 'pr', '42', 'review', 'manager.claim');
    assert.equal(fs.existsSync(claimPath), true);
    assert.equal(fs.readFileSync(claimPath, 'utf8'), '');
  } finally {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) child.kill();
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

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
  assert.match(result.stdout, /REVIEW_MANAGER_ALREADY_CLAIMED/);
});

test('CLI exits non-zero when <ISSUE> is omitted', () => {
  const result = spawnSync(process.execPath, [pollPrPath], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage/);
});
