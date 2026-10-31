'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// run-review-manager.js の CLI 実行部は require.main === module でガードされているため、
// require するだけでは実プロセスをspawnしない
//
//
// レビュー観点の選択（旧 heavy/directed モード、MODE=/ASPECTS=/--brief-file、
// review-manager-<PR>.meta.json）は廃止した。ファイルパターンでの機械的な観点自動判定が
// 一部の観点だけに絞り込んでしまい他の観点のレビューが丸ごと欠落する実障害があったため、
// 観点を絞り込むかどうかの判断はオーケストレーター側からは完全に排除し、Review Manager
// 自身がPR diffを見た上で判断する方式に一本化した（skills/gh-maestro-reviewer/SKILL.md参照）。
const {
  buildPrompt, buildFinalizePrompt, generateStagingPath,
  validateArtifactContent, atomicCopyStaging,
  boundedCleanup, pollForArtifact,
  superviseReviewManager, clearStaleIncompleteSentinel, resetRetryCount,
  findIncompleteSentinel, readIncompleteSentinel, incompleteSentinelOutcome,
  persistReviewManifest, runJobsDeterministically, mapAgentPhaseFailure,
  _validateFindingShape, _validateAgainstSchema,
  _setPollForArtifact, _setRunReviewJobsOnce,
} = require('../../scripts/run-review-manager');

const SKILL_MD = 'C:\\canonical\\skills\\gh-maestro-reviewer\\SKILL.md';
const { reviewArtifactPath } = require('../../scripts/shared/review-manager-paths');
const { reviewManagerStartingPath } = require('../../scripts/shared/running-review-managers');
const { spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'run-review-manager.js');

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-run-rm-' + Date.now());

before(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── buildPrompt（フェーズ1: 計画） ────────────────────────────────────────







// ── buildFinalizePrompt（フェーズ2: 統合・完否判断） ──────────────────────



// ── runJobsDeterministically / judgeJobRun（決定論的ジョブ実行・モデル介入なし） ──
// 実プロセス（run-review-jobs.js）はspawnせず、注入した終了結果 {status,error} 分岐を検証する
//
//
// judgeJobRun は終了コードと副作用を組み合わせて監督結果を判定する:
//   - status 1 + 結果JSON存在 → results-ready（ジョブが回って失敗が残った）
//   - 不完全センチネル存在 → incomplete（manifest検証失敗・再試行上限）
//   - どちらも無い（or status 2/null/error）→ exec-failed（フェーズ2へ進めてはならない）

// 一時ディレクトリに ghDir/reviewWtDir/results/センチネル用パスを作る。
function makeJobFixtures() {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'job-'));
  const ghDir = path.join(dir, 'gh'); // findIncompleteSentinel は ghDir をワークスペースルートとみなし .gh-maestro を付ける
  const reviewWtDir = path.join(dir, 'wt');
  const pr = '5';
  fs.mkdirSync(reviewWtDir, { recursive: true });
  const resultsPath = path.join(reviewWtDir, 'review-results-5.json');
  const sentinelPath = reviewArtifactPath(dir, pr, '.incomplete');
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  return { dir, ghDir, reviewWtDir, pr, resultsPath, sentinelPath };
}











// ── mapAgentPhaseFailure（フェーズ結果 → 監督結果の写像） ───────────────────
// superviseReviewManager が2フェーズ化でエージェントを複数回起動するようになり、
// 各フェーズの失敗を旧来の成果物未検出系 outcome へ写像する。この写像は純関数。




// ── generateStagingPath ──────────────────────────────────────────────────


// ── CLI引数パース（scripts/shared/workspace.js の parseFlags に委譲） ─────────

test('サブプロセス経由: --help は終了コード0でUsageを表示する', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /run-review-manager\.js/);
});

test('サブプロセス経由: 位置引数が不足しているとUsageエラーになる', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '5', 'o/r'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

// ── setupReviewWorktree / teardownReviewWorktree の node_modules 取り扱い ─────
// 実障害: RM専用worktreeに node_modules が無く、プロジェクトのツール（tsx等）起動時に
// MODULE_NOT_FOUND になった（Issue #155）。通常ワーカー（spawn-worker.js）は
// linkNodeModules でメインワークスペースへjunctionリンクしているが、RM側に未移植だった。



// ── validateArtifactContent ──────────────────────────────────────────────










// ── _validateFindingShape ────────────────────────────────────────────────



// ── _validateAgainstSchema ───────────────────────────────────────────────



// ── atomicCopyStaging ────────────────────────────────────────────────────




// ── pollForArtifact ──────────────────────────────────────────────────────

test('pollForArtifact: ファイルが最初から存在すれば即座に検出する', async () => {
  const artifactPath = path.join(tmpBase, 'poll-immediate.json');
  fs.writeFileSync(artifactPath, '{"ok":true}', 'utf8');

  const result = await pollForArtifact(artifactPath, 5000, 50, { aborted: false });
  assert.equal(result.found, true);
  assert.equal(result.content, '{"ok":true}');
});


test('pollForArtifact: deadlineを過ぎると見つからずに終了する', async () => {
  const artifactPath = path.join(tmpBase, 'poll-deadline.json');
  try { fs.unlinkSync(artifactPath); } catch {}

  const result = await pollForArtifact(artifactPath, 200, 30, { aborted: false });
  assert.equal(result.found, false);
  assert.equal(result.reason, 'deadline');
});


test('pollForArtifact: 空ファイルは未完成とみなし検出しない', async () => {
  const artifactPath = path.join(tmpBase, 'poll-empty.json');
  // 空ファイルを即座に作成
  fs.writeFileSync(artifactPath, '', 'utf8');

  const result = await pollForArtifact(artifactPath, 200, 30, { aborted: false });
  // 空ファイルは検出されず、deadlineで終了する
  assert.equal(result.found, false);
});


test('pollForArtifact: 後から出現するファイルを検出する（atomic renameシミュレーション）', async () => {
  const artifactPath = path.join(tmpBase, 'poll-delayed.json');
  // 事前に削除しておく
  try { fs.unlinkSync(artifactPath); } catch {}

  // 300ms後にファイルを作成（atomic renameのシミュレーション）
  const timer = setTimeout(() => {
    fs.writeFileSync(artifactPath, '{"delayed":true}', 'utf8');
  }, 300);

  const result = await pollForArtifact(artifactPath, 5000, 50, { aborted: false });
  clearTimeout(timer);

  assert.equal(result.found, true);
  assert.equal(result.content, '{"delayed":true}');
});


test('pollForArtifact: シグナルでabortされると即座に終了する', async () => {
  const artifactPath = path.join(tmpBase, 'poll-abort.json');
  try { fs.unlinkSync(artifactPath); } catch {}

  const signal = { aborted: false };
  // 100ms後にabort
  setTimeout(() => { signal.aborted = true; }, 100);

  const result = await pollForArtifact(artifactPath, 5000, 30, signal);
  assert.equal(result.found, false);
  assert.equal(result.reason, 'aborted');
});


// ── boundedCleanup ───────────────────────────────────────────────────────




// ── superviseReviewManager: spawn error 即時検出 ─────────────────────────
// Issue: 非同期spawn失敗（ENOENT等）でerrorイベントが発火しても、監督ループが
// processExitedを知らず30分deadlineを待ち続けていた。errorハンドラが
// markProcessDoneでsignal.abortedを設定することで即座に戻ることを検証する。


// ── superviseReviewManager: pollForArtifact 呼び出し検証 ─────────────────
// Issue: supervisorがpollForArtifactを使わず重複実装していた。
// 注入されたpollForArtifactが呼ばれ、テストと同じ実装が本番でも使われることを検証する。


// ── superviseReviewManager: 無効な成果物の削除と再ポーリング ────────────
// 検証不合格の成果物は削除され、pollForArtifactが再呼び出しされることを検証する。


// ── Issue #248 項目4: clearStaleIncompleteSentinel ─────────────────────────
// 再レビュー周回の開始（superviseReviewManager ステップ1）で、前周回の古い
// .incomplete センチネルを消す。残っていると新周回の途中結果を「不完全完了」と
// 誤判定してしまう。




// ── Issue #273: resetRetryCount（再試行カウンタの周回開始リセット） ─────────
// 新レビュー周回の開始（superviseReviewManager ステップ1）で、前周回の再試行カウンタを消す。
// 残っていると新周回が最初から「上限到達」と誤判定される（受け入れ条件「新しいレビューが
// 始まるときには回数がリセットされ、前のレビューの回数を引きずらない」）。





// ── Issue #271: センチネル検出（main/worktree両方）と manifest 永続化 ─────────
// 検証失敗時に run-review-jobs.js が worktree 側へ書く .incomplete センチネルも
// 検出できること（main側だけ見ると黙って process-exit-no-artifact になる）、および
// boundedCleanup が worktree を破壊する前に manifest を main の record へ退避できることを
// 検証する。







// ── PR #272 レビュー指摘: notify-failedセンチネルは失敗として観測する ──────
// 欠陥Aの監督側: run-review-jobs.js が検証失敗通知のPR投稿に失敗したとき、
// 投稿成功センチネル（incomplete-review）を exit 0 の「不完全完了」として扱うと、
// オーケストレーターが通知済みと誤認する。notify-failed は exit 1 の失敗にする。





// ── SKILL.md 絶対パス指定（PR #350 実障害対策） ─────────────────────────────

// ── worktree の node_modules junction と破棄（実 git・実 junction を使う） ──────
// 実障害: RM専用worktreeに node_modules が無く、プロジェクトのツール起動時に
// MODULE_NOT_FOUND になった（Issue #155）。setupReviewWorktree が実際に junction を張り、
// worktree から workspace の node_modules を参照できることを検証する。
// 文字列の存在ではなく、作成された worktree の振る舞いで確認する。

const {
  setupReviewWorktree, teardownReviewWorktree,
} = require('../../scripts/run-review-manager');
const { reviewWorktreeDir } = require('../../scripts/shared/review-manager-paths');
const processLiveness = require('../../scripts/shared/process-liveness');

function gitInitRepoWithCommit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' });
  assert.equal(git(['init']).status, 0);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a', 'utf8');
  assert.equal(git(['add', 'a.txt']).status, 0);
  assert.equal(git(['commit', '-m', 'init']).status, 0);
  return git;
}

test('setupReviewWorktree: 作成した worktree から workspace の node_modules を参照できる（junction 経由）', () => {
  const ws = path.join(tmpBase, 'setup-link-ws');
  const git = gitInitRepoWithCommit(ws);
  fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'node_modules', 'marker.txt'), 'marker', 'utf8');

  // PR head を refs/pull/77/head として持つ origin（ローカルの bare リポジトリ）を用意する
  const origin = path.join(tmpBase, 'setup-link-origin.git');
  assert.equal(spawnSync('git', ['init', '--bare', origin], { encoding: 'utf8' }).status, 0);
  assert.equal(git(['remote', 'add', 'origin', origin]).status, 0);
  assert.equal(git(['push', 'origin', 'HEAD:refs/pull/77/head']).status, 0);

  const dir = setupReviewWorktree(ws, '77', () => {});
  try {
    // linkNodeModules が junction を張っていなければ、この参照は失敗する
    assert.equal(fs.readFileSync(path.join(dir, 'node_modules', 'marker.txt'), 'utf8'), 'marker');
  } finally {
    teardownReviewWorktree(ws, '77', () => {});
  }
});

test('teardownReviewWorktree: junction を除去しても、リンク先の node_modules は残る', () => {
  // 検証対象は「リンク先を巻き込まない」という結果であり、呼び出し順は固定しない。
  const ws = path.join(tmpBase, 'teardown-junction-ws');
  fs.mkdirSync(ws, { recursive: true });
  const external = path.join(tmpBase, 'teardown-junction-external', 'node_modules');
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, 'keep.txt'), 'keep', 'utf8');

  const dir = reviewWorktreeDir(ws, '78');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(external, path.join(dir, 'node_modules'), 'junction');

  teardownReviewWorktree(ws, '78', () => {});

  assert.equal(fs.existsSync(path.join(external, 'keep.txt')), true, 'リンク先の node_modules を消さない');
  assert.equal(fs.existsSync(dir), false, 'worktree ディレクトリは破棄される');
});

// ── boundedCleanup: worktree 破棄の条件（退行経路3） ─────────────────────────
// 検証対象: プロセスが停止確認できた（processStopped）か、起動前の pid が無い（pid == null）ときだけ
// worktree を破棄する。停止を確認できなければ（unknown）worktree を残す。
// 担当テストは worktreeDir・workspace・pr を渡して worktree 経路を通す。
// 生死の判定だけを注入し、プロセスは実際には停止させない（unknown と dead のみを返す）。

// resource key は 64 桁の16進数（process-liveness の RESOURCE_KEY_RE）
const KEY_STOPPED = 'a'.repeat(64);
const KEY_UNKNOWN = 'b'.repeat(64);

test('boundedCleanup: 停止を確認できたら worktree を破棄し、停止できなければ残す', async () => {
  const ws = path.join(tmpBase, 'bounded-wt-ws');
  fs.mkdirSync(ws, { recursive: true });
  const dir = reviewWorktreeDir(ws, '79');
  // endpoint の照会結果だけを注入する（resource key を持つ参照でのみ生死判定が走る）
  const liveness = processLiveness.createLiveness({
    probeEndpoint: (endpoint) => (endpoint.includes(KEY_STOPPED.slice(0, 16)) ? 'dead' : 'unknown'),
    readStartTime: () => '2026-08-28T00:00:00.000Z',
  });

  // 1. 停止を確認（dead）→ worktree を破棄する
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x', 'utf8');
  const stopped = await boundedCleanup({
    pid: 4242, processRef: liveness.captureProcess(4242, KEY_STOPPED), worktreeDir: dir, workspace: ws, pr: '79',
    lockFile: null, liveness, log: () => {}, gracefulShutdownMs: 0,
  });
  assert.equal(stopped.processStopped, true);
  assert.equal(stopped.worktreeCleaned, true);
  assert.equal(fs.existsSync(dir), false, '停止確認後は worktree を破棄する');

  // 2. 生死を判定できない（unknown）→ worktree を残す（kill も行われない）
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x', 'utf8');
  // 自分が書いた lease（manager.running）を置く。生死を判定できないときは lease も残す。
  const lockFile = path.join(ws, 'manager.running');
  const lockOwner = liveness.captureProcess(4243, KEY_UNKNOWN);
  fs.writeFileSync(lockFile, JSON.stringify(liveness.writeRef({}, lockOwner)), 'utf8');
  const unknown = await boundedCleanup({
    pid: 4243, processRef: liveness.captureProcess(4243, KEY_UNKNOWN), worktreeDir: dir, workspace: ws, pr: '79',
    lockFile, lockOwner, liveness, log: () => {}, gracefulShutdownMs: 0,
  });
  assert.equal(unknown.processStopped, false);
  assert.equal(unknown.worktreeCleaned, false);
  assert.equal(unknown.leaseReleased, false);
  assert.equal(fs.existsSync(path.join(dir, 'f.txt')), true, '生死を判定できないときは worktree を残す');
  assert.equal(fs.existsSync(lockFile), true, '生死を判定できないときは lease（manager.running）を残す');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(lockFile, { force: true });

  // 3. 起動前の pid が無い（pid == null）→ worktree を破棄する
  fs.mkdirSync(dir, { recursive: true });
  const noPid = await boundedCleanup({
    pid: null, worktreeDir: dir, workspace: ws, pr: '79',
    lockFile: null, liveness, log: () => {}, gracefulShutdownMs: 0,
  });
  assert.equal(noPid.worktreeCleaned, true);
  assert.equal(fs.existsSync(dir), false);
});
