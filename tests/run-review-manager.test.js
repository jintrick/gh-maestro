'use strict';

const { installLivenessTestAdapter } = require('./helpers/process-liveness-test-double');
installLivenessTestAdapter();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const processLiveness = require('../scripts/shared/process-liveness');
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
  boundedCleanup,
  superviseReviewManager, clearStaleIncompleteSentinel, resetRetryCount,
  findIncompleteSentinel, readIncompleteSentinel, incompleteSentinelOutcome,
  persistReviewManifest, runJobsDeterministically, mapAgentPhaseFailure,
  _validateFindingShape, _validateAgainstSchema,
  _setPollForArtifact, _setRunReviewJobsOnce,
} = require('../scripts/run-review-manager');

const SKILL_MD = 'C:\\canonical\\skills\\gh-maestro-reviewer\\SKILL.md';
const { reviewArtifactPath } = require('../scripts/shared/review-manager-paths');
const { reviewManagerStartingPath } = require('../scripts/shared/running-review-managers');
const { spawnSync } = require('child_process');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'run-review-manager.js');

const tmpBase = path.join(os.tmpdir(), 'gh-maestro-test-run-rm-' + Date.now());

before(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

after(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
});

// ── buildPrompt（フェーズ1: 計画） ────────────────────────────────────────

test('buildPrompt supplies concise phase-1 startup context and manifest path', () => {
  const { prompt } = buildPrompt({
    pr: '5', repo: 'o/r', issue: '260', workspace: 'C:\\ws',
    mainGhDir: 'C:\\main\\.gh-maestro', skillPath: SKILL_MD,
  });
  assert.match(prompt, /PR=5/);
  assert.match(prompt, /REPO=o\/r/);
  assert.match(prompt, /ISSUE=260/);
  // 再試行カウンタ永続化先（メインワークスペース ghDir）を渡す（Issue #273）
  assert.match(prompt, /GH_DIR=C:\/main\/\.gh-maestro/);
  assert.match(prompt, /Review Manager フェーズ1/);
  assert.match(prompt, /manifest\.json/);
  assert.doesNotMatch(prompt,
    /adopted \/ excluded|ジョブを実行しない|全体ビルド|manifest書き出し後に即終了|決定論的スーパーバイザが行う|OUTPUTファイルへ直接書き込まない|msg-send\.js|完了報告/);
  assert.ok(typeof prompt === 'string');
});

test('buildPrompt normalizes backslash paths to forward slashes', () => {
  const { prompt } = buildPrompt({
    pr: '5', repo: 'o/r', workspace: 'C:\\ws',
    mainGhDir: 'C:\\main\\.gh-maestro', skillPath: SKILL_MD,
  });
  assert.match(prompt, /WORKSPACE=C:\/ws/);
  assert.match(prompt, /GH_DIR=C:\/main\/\.gh-maestro/);
  // manifest 書き出し先パスも正規化される
  assert.match(prompt, /C:\/ws\/\.gh-maestro\/records\/pr\/5\/review\/manifest\.json/);
});

test('buildPrompt: paths and phase inputs include the instruction to read the phase skill', () => {
  const { prompt } = buildPrompt({
    pr: '5', repo: 'o/r', workspace: 'C:\\ws',
    mainGhDir: 'C:\\main\\.gh-maestro', skillPath: SKILL_MD,
  });
  assert.match(prompt, /SCRIPTS=/);
  assert.match(prompt, /MANIFEST=/);
  assert.match(prompt, /SKILL=C:\/canonical\/skills\/gh-maestro-reviewer\/SKILL\.md/);
  assert.match(prompt, /SKILL に指定されたファイルを読み、そこに記載されたフェーズ1の手順を実行してください/);
});

// ── buildFinalizePrompt（フェーズ2: 統合・完否判断） ──────────────────────

test('buildFinalizePrompt supplies concise phase-2 paths for result integration', () => {
  const { prompt } = buildFinalizePrompt({
    pr: '5', repo: 'o/r', issue: '260', workspace: 'C:\\ws',
    outputFile: 'C:\\ws\\out.json', mainGhDir: 'C:\\main\\.gh-maestro',
    resultsFile: 'C:\\ws\\results.json', skillPath: SKILL_MD,
  });
  assert.match(prompt, /PR=5/);
  assert.match(prompt, /Review Manager フェーズ2/);
  assert.match(prompt, /OUTPUT=C:\/ws\/out\.json/);
  assert.match(prompt, /RESULTS=C:\/ws\/results\.json/);
  assert.match(prompt, /SKILL=C:\/canonical\/skills\/gh-maestro-reviewer\/SKILL\.md/);
  assert.match(prompt, /SKILL に指定されたファイルを読み、そこに記載されたフェーズ2の手順を実行してください/);
  assert.match(prompt, /DRAFT=C:\/ws\/\.staging-out\.json\./);
});

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

test('runJobsDeterministically: 初回全成功(0)は再試行なしでresults-ready', () => {
  const fx = makeJobFixtures();
  const calls = [];
  try {
    _setRunReviewJobsOnce(({ log }) => { calls.push(1); log('injected'); return { status: 0, error: null }; });
    const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
    assert.equal(r.outcome, 'results-ready');
    assert.equal(calls.length, 1, 'should run exactly once (no retry)');
  } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('runJobsDeterministically: 一部失敗(1,結果JSONあり)→再試行→成功(0)でresults-ready', () => {
  const fx = makeJobFixtures();
  fs.writeFileSync(fx.resultsPath, '{}', 'utf8'); // ジョブ失敗経路では結果JSONが書かれる
  const calls = [];
  const codes = [1, 0];
  _setRunReviewJobsOnce(() => { calls.push(1); return { status: codes.shift(), error: null }; });
  try {
    const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
    assert.equal(r.outcome, 'results-ready');
    assert.equal(calls.length, 2, 'should retry once after partial failure');
  } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('runJobsDeterministically: 再試行後も失敗(1→1,結果JSONあり)はresults-ready（完否判断はフェーズ2 RM）', () => {
  const fx = makeJobFixtures();
  fs.writeFileSync(fx.resultsPath, '{}', 'utf8');
  const calls = [];
  const codes = [1, 1];
  _setRunReviewJobsOnce(() => { calls.push(1); return { status: codes.shift(), error: null }; });
  try {
    const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
    assert.equal(r.outcome, 'results-ready');
    assert.equal(calls.length, 2);
  } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('runJobsDeterministically: manifest検証失敗(2,センチネル書く)は再試行せずincomplete', () => {
  const fx = makeJobFixtures();
  const calls = [];
  _setRunReviewJobsOnce(() => {
    calls.push(1);
    // run-review-jobs は manifest 検証失敗時に不完全センチネルを書いてから exit 2
    fs.writeFileSync(fx.sentinelPath, JSON.stringify({ pr: fx.pr, reason: 'manifest-validation-failed' }), 'utf8');
    return { status: 2, error: null };
  });
  try {
    const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
    assert.equal(r.outcome, 'incomplete');
    assert.equal(calls.length, 1, 'manifest validation failure must not retry');
  } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('runJobsDeterministically: 構造的失敗(2)は結果JSONが残っていてもexec-failed', () => {
  const fx = makeJobFixtures();
  fs.writeFileSync(fx.resultsPath, '{}', 'utf8');
  const calls = [];
  _setRunReviewJobsOnce(() => { calls.push(1); return { status: 2, error: null }; });
  try {
    const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
    assert.equal(r.outcome, 'exec-failed');
    assert.equal(calls.length, 1, '構造的失敗は再試行しない');
  } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('runJobsDeterministically: 再試行上限(3,センチネル書く)は再試行せずincomplete', () => {
  const fx = makeJobFixtures();
  const calls = [];
  _setRunReviewJobsOnce(() => {
    calls.push(1);
    // run-review-jobs は再試行上限時に finalize-review --mode incomplete がセンチネルを書く
    fs.writeFileSync(fx.sentinelPath, JSON.stringify({ pr: fx.pr, reason: 'incomplete-review' }), 'utf8');
    return { status: 3, error: null };
  });
  try {
    const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
    assert.equal(r.outcome, 'incomplete');
    assert.equal(calls.length, 1);
  } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('runJobsDeterministically: 再試行後のmanifest検証失敗(2)/上限(3)もincomplete', () => {
  for (const second of [2, 3]) {
    const fx = makeJobFixtures();
    fs.writeFileSync(fx.resultsPath, '{}', 'utf8'); // 初回の一時的ジョブ失敗で結果は残る
    const codes = [1, second];
    _setRunReviewJobsOnce(() => {
      const code = codes.shift();
      // 2/3 はその実行中にセンチネルを書く（manifest検証失敗・再試行上限）
      if (code === 2 || code === 3) {
        fs.writeFileSync(fx.sentinelPath, JSON.stringify({ pr: fx.pr, reason: 'incomplete-review' }), 'utf8');
      }
      return { status: code, error: null };
    });
    try {
      const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
      assert.equal(r.outcome, 'incomplete', `code sequence [1,${second}] should be incomplete`);
    } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  }
});

test('runJobsDeterministically: 一部失敗(1)で結果JSONが無い(読めない)場合はexec-failedで進めない（Issue #292 レビュー指摘）', () => {
  const fx = makeJobFixtures();
  // 結果JSONを作らない。非0なのに結果が無い → 何らかの未知の失敗。results-ready を返さない。
  const calls = [];
  _setRunReviewJobsOnce(() => { calls.push(1); return { status: 1, error: null }; });
  try {
    const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
    assert.equal(r.outcome, 'exec-failed');
    assert.equal(calls.length, 1, 'unknown failure must not retry');
  } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('runJobsDeterministically: 起動失敗(status null)はexec-failedで再試行しない（Issue #292 レビュー指摘）', () => {
  // error あり＝spawn 失敗（reason に「spawn 失敗」）、error なし＝シグナル終了。どちらも再試行せず exec-failed。
  for (const result of [{ status: null, error: 'spawn ENOENT' }, { status: null, error: null }]) {
    const fx = makeJobFixtures();
    const calls = [];
    _setRunReviewJobsOnce(() => { calls.push(1); return result; });
    try {
      const r = runJobsDeterministically({ manifestPath: 'm', resultsPath: fx.resultsPath, pr: fx.pr, repo: 'o/r', workspace: fx.dir, ghDir: fx.ghDir, reviewWtDir: fx.reviewWtDir, log: () => {} });
      assert.equal(r.outcome, 'exec-failed');
      assert.equal(calls.length, 1, 'spawn failure or signal exit must not be retried into results-ready');
      if (result.error) assert.match(r.reason, /spawn 失敗/);
    } finally { _setRunReviewJobsOnce(null); fs.rmSync(fx.dir, { recursive: true, force: true }); }
  }
});

// 退行経路4（PR #655〜）: runReviewJobsOnce の子プロセス（run-review-jobs.js）の env と argv。
// 親の参照（GH_MAESTRO_REVIEW_PARENT_REF）と、本体 workspace（GH_MAESTRO_WORKSPACE の上書き）が
// 子へ届くこと、argv に --gh-dir と --workspace が組まれることを検査する。
// 子プロセスは spawnSync の差し替えで実際には起動しない（実 run-review-jobs は別テストの対象）。
test('runReviewJobsOnce: 子の env に親の参照と本体 workspace を渡し、argv に gh-dir と workspace を組む', () => {
  const sharedChildProcess = require('../scripts/shared/child-process');
  const realSpawnSync = sharedChildProcess.spawnSync;
  const calls = [];
  const modPath = require.resolve('../scripts/run-review-manager');
  let mod;
  sharedChildProcess.spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '', stderr: '', error: undefined };
  };
  try {
    delete require.cache[modPath];
    mod = require(modPath); // run-review-manager は読み込み時に spawnSync を束縛するため、差し替え後に読み直す
  } finally {
    sharedChildProcess.spawnSync = realSpawnSync;
  }
  try {
    const ws = path.join(tmpBase, 'run-jobs-env-ws');
    const ghDir = path.join(ws, '.gh-maestro');
    const reviewWtDir = path.join(ws, '.gh-maestro', 'worktrees', 'review-pr-5');
    mod.runReviewJobsOnce({
      manifestPath: path.join(ghDir, 'm.json'), resultsPath: path.join(ghDir, 'r.json'),
      pr: '5', repo: 'o/r', ghDir, reviewWtDir, log: () => {}, parentRef: 'parent-ref-literal',
    });

    assert.equal(calls.length, 1, '子プロセスは1回だけ起動される');
    const { args, opts } = calls[0];
    assert.equal(path.basename(args[0]), 'run-review-jobs.js');
    assert.equal(args[args.indexOf('--gh-dir') + 1], ghDir);
    assert.equal(args[args.indexOf('--workspace') + 1], reviewWtDir);
    assert.equal(opts.cwd, reviewWtDir);
    assert.equal(opts.env.GH_MAESTRO_REVIEW_PARENT_REF, 'parent-ref-literal', '親の参照が子へ届く');
    assert.equal(opts.env.GH_MAESTRO_WORKSPACE, ws, '本体 workspace（ghDir の親）で上書きされる');
  } finally {
    delete require.cache[modPath];
    require(modPath); // 以降のテストが通常の読み込み状態を見るように戻す
  }
});

// ── mapAgentPhaseFailure（フェーズ結果 → 監督結果の写像） ───────────────────
// superviseReviewManager が2フェーズ化でエージェントを複数回起動するようになり、
// 各フェーズの失敗を旧来の成果物未検出系 outcome へ写像する。この写像は純関数。

test('mapAgentPhaseFailure: exit を process-exit-no-artifact へ写像する', () => {
  const r = mapAgentPhaseFailure({ outcome: 'exit', exitCode: 5, agentPid: 42, reason: 'boom' }, 'wt');
  assert.equal(r.outcome, 'process-exit-no-artifact');
  assert.equal(r.exitCode, 5);
  assert.equal(r.agentPid, 42);
  assert.equal(r.reviewWtDir, 'wt');
  assert.equal(r.reason, 'boom');
});

test('mapAgentPhaseFailure: timeout を timeout へ写像する', () => {
  const r = mapAgentPhaseFailure({ outcome: 'timeout', exitCode: 1, agentPid: 42, reason: 'deadline' }, 'wt');
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.reason, 'deadline');
});

test('mapAgentPhaseFailure: setup/agent-config失敗を setup-failed へ写像する', () => {
  const r = mapAgentPhaseFailure({ outcome: 'agent-config-failed', exitCode: 1, agentPid: null, reason: 'no config' }, 'wt');
  assert.equal(r.outcome, 'setup-failed');
  assert.equal(r.exitCode, 1);
  assert.equal(r.reason, 'no config');
});

// ── generateStagingPath ──────────────────────────────────────────────────

test('generateStagingPath: 一意のstagingパスを生成する', () => {
  const finalPath = path.join(tmpBase, 'findings.json');
  const staging = generateStagingPath(finalPath);
  assert.equal(path.dirname(staging), path.dirname(finalPath));
  assert.ok(path.basename(staging).startsWith('.staging-'));
  assert.ok(staging.includes(String(process.pid)));
});

// ── CLI引数パース（scripts/shared/workspace.js の parseFlags に委譲） ─────────



// ── validateArtifactContent ──────────────────────────────────────────────

test('validateArtifactContent: 有効なpayloadを合格とする', () => {
  // 同じ有効 finding を _validateFindingShape に直接渡しても合格（統合元: 449）
  assert.equal(_validateFindingShape({
    aspect: 'Correctness', path: 'f.js', line_anchor: 'x',
    summary: 's', severity: 'MAJOR', severity_rationale: 'r',
    body: 'b', verified_references: ['r'],
  }).length, 0);

  const payload = JSON.stringify({
    pr: 5,
    repo: 'o/r',
    headRefOid: 'abc123',
    findings: [
      {
        aspect: 'Correctness',
        path: 'src/foo.js',
        line_anchor: 'await save()',
        summary: 'missing await',
        severity: 'BLOCKER',
        severity_rationale: 'data loss risk',
        body: '## Details\n\nThe issue is...',
        verified_references: ['src/foo.js'],
      },
    ],
  });
  const result = validateArtifactContent(payload, null);
  assert.equal(result.valid, true);
  assert.notEqual(result.payload, null);
});

test('validateArtifactContent: BOM付きのReview Manager成果物を合格とする', () => {
  const result = validateArtifactContent('\uFEFF' + JSON.stringify({
    pr: 5,
    repo: 'o/r',
    headRefOid: 'abc',
    findings: [],
  }), null);
  assert.equal(result.valid, true);
  assert.deepEqual(result.payload.findings, []);
});

test('validateArtifactContent: 不正なJSONは不合格', () => {
  const result = validateArtifactContent('not json', null);
  assert.equal(result.valid, false);
  assert.match(result.error, /JSON parse/);
});

test('validateArtifactContent: 空オブジェクトは不合格', () => {
  const result = validateArtifactContent('{}', null);
  assert.equal(result.valid, false);
  assert.match(result.error, /pr must be/);
});

test('validateArtifactContent: findingsが配列でないと不合格', () => {
  const result = validateArtifactContent(JSON.stringify({
    pr: 1, repo: 'r', headRefOid: 'abc', findings: 'not-an-array',
  }), null);
  assert.equal(result.valid, false);
  assert.match(result.error, /findings must be an array/);
});

test('validateArtifactContent: findingに必須フィールドがないと不合格', () => {
  const result = validateArtifactContent(JSON.stringify({
    pr: 1, repo: 'r', headRefOid: 'abc',
    findings: [{ aspect: 'Correctness' }],
  }), null);
  assert.equal(result.valid, false);
  assert.match(result.error, /finding\[0\].*path.*required/);
  // finding が null（オブジェクトでない）も同じ検査経路で不合格（統合元: 444）
  assert.ok(_validateFindingShape(null).length > 0);
});

test('validateArtifactContent: 不正なaspect値は不合格', () => {
  const result = validateArtifactContent(JSON.stringify({
    pr: 1, repo: 'r', headRefOid: 'abc',
    findings: [{
      aspect: 'InvalidAspect', path: 'f.js', line_anchor: 'x',
      summary: 's', severity: 'BLOCKER', severity_rationale: 'r',
      body: 'b', verified_references: ['r'],
    }],
  }), null);
  assert.equal(result.valid, false);
  assert.match(result.error, /invalid aspect/);
});

test('validateArtifactContent: 不正なseverity値は不合格', () => {
  const result = validateArtifactContent(JSON.stringify({
    pr: 1, repo: 'r', headRefOid: 'abc',
    findings: [{
      aspect: 'Correctness', path: 'f.js', line_anchor: 'x',
      summary: 's', severity: 'CRITICAL', severity_rationale: 'r',
      body: 'b', verified_references: ['r'],
    }],
  }), null);
  assert.equal(result.valid, false);
  assert.match(result.error, /invalid severity/);
});

test('validateArtifactContent: verified_referencesが空配列だと不合格', () => {
  const result = validateArtifactContent(JSON.stringify({
    pr: 1, repo: 'r', headRefOid: 'abc',
    findings: [{
      aspect: 'Correctness', path: 'f.js', line_anchor: 'x',
      summary: 's', severity: 'MAJOR', severity_rationale: 'r',
      body: 'b', verified_references: [],
    }],
  }), null);
  assert.equal(result.valid, false);
  assert.match(result.error, /verified_references/);
});

// ── _validateAgainstSchema ───────────────────────────────────────────────

test('_validateAgainstSchema: 有効なpayloadを合格とする', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'review-findings-schema.json'), 'utf8'
  ));
  const payload = {
    pr: 5, repo: 'o/r', headRefOid: 'abc',
    findings: [{
      aspect: 'Correctness', path: 'f.js', line_anchor: 'x',
      summary: 's', severity: 'MAJOR', severity_rationale: 'r',
      body: 'b', verified_references: ['r'],
    }],
  };
  const errors = _validateAgainstSchema(payload, schema);
  assert.equal(errors.length, 0);
});

test('_validateAgainstSchema: additionalProperties:false で未知フィールドを検出する', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  };
  const errors = _validateAgainstSchema({ name: 'ok', extra: true }, schema);
  assert.ok(errors.some(e => e.includes('unexpected')), `unexpected field should be detected: ${errors}`);
});

// ── atomicCopyStaging ────────────────────────────────────────────────────

test('atomicCopyStaging: ファイルをコピーし、元の内容と一致する', () => {
  const srcFile = path.join(tmpBase, 'atomic-src.json');
  const dstFile = path.join(tmpBase, 'atomic-dst.json');
  fs.writeFileSync(srcFile, '{"test":true}', 'utf8');

  const result = atomicCopyStaging(srcFile, dstFile);
  assert.equal(result.success, true);
  assert.ok(fs.existsSync(dstFile));
  assert.equal(fs.readFileSync(dstFile, 'utf8'), '{"test":true}');
});

test('atomicCopyStaging: コピー先に一時ファイルが残らない', () => {
  const srcFile = path.join(tmpBase, 'atomic-src2.json');
  const dstFile = path.join(tmpBase, 'subdir', 'atomic-dst2.json');
  fs.writeFileSync(srcFile, 'hello', 'utf8');

  const result = atomicCopyStaging(srcFile, dstFile);
  assert.equal(result.success, true);

  // 一時ファイル（.tmp-プレフィックス）が残っていない
  const dstDir = path.dirname(dstFile);
  const children = fs.readdirSync(dstDir);
  const tmpFiles = children.filter(c => c.startsWith('.tmp-'));
  assert.equal(tmpFiles.length, 0, `no tmp files should remain: ${tmpFiles.join(', ')}`);
});

test('atomicCopyStaging: 存在しないsrcは失敗する', () => {
  const result = atomicCopyStaging(
    path.join(tmpBase, 'nonexistent.json'),
    path.join(tmpBase, 'dst.json'),
  );
  assert.equal(result.success, false);
  assert.ok(result.error);
});

// ── pollForArtifact ──────────────────────────────────────────────────────

// ── boundedCleanup ───────────────────────────────────────────────────────

test('boundedCleanup: 存在しないPIDでもエラーなく完了する（プロセス停止スキップ）', async () => {
  const testDir = path.join(tmpBase, 'cleanup-no-pid');
  fs.mkdirSync(testDir, { recursive: true });
  const lockFile = path.join(testDir, 'test.running');

  const logs = [];
  const liveness = processLiveness.createLiveness({
    probePid: (pid) => pid === 999999 ? 'dead' : 'alive',
    readStartTime: () => '2026-08-28T00:00:00.000Z',
  });
  const lockOwner = liveness.captureSelf();
  fs.writeFileSync(lockFile, JSON.stringify(liveness.writeRef({}, lockOwner)));
  const result = await boundedCleanup({
    pid: 999999, // 存在しないPID
    processRef: liveness.captureProcess(999999),
    worktreeDir: null,
    workspace: null,
    pr: null,
    lockFile,
    lockOwner,
    liveness,
    log: (msg) => logs.push(msg),
    gracefulShutdownMs: 100,
  });

  // プロセス停止は成功扱い（存在しないので isProcessAlive が false）
  assert.equal(result.processStopped, true);
  // PIDが無効でもleaseは解放される（プロセス停止が「成功」判定）
  assert.equal(result.leaseReleased, true);
});

test('boundedCleanup: manager.running は所有者とOS resourceが一致する場合だけ解放する', async () => {
  const testDir = path.join(tmpBase, 'cleanup-owner');
  fs.mkdirSync(testDir, { recursive: true });
  const ownedFile = path.join(testDir, 'owned.running');
  const foreignFile = path.join(testDir, 'foreign.running');
  const liveness = processLiveness.createLiveness({
    probePid: () => 'alive',
  });
  const ownerRef = liveness.captureSelf();
  fs.writeFileSync(ownedFile, JSON.stringify(liveness.writeRef({ startTime: '2026-08-28T00:00:00.000Z' }, ownerRef)), 'utf8');
  const foreignRef = liveness.captureProcess(67890, 'foreign-resource');
  fs.writeFileSync(foreignFile, JSON.stringify(liveness.writeRef({ startTime: '2026-08-28T00:01:00.000Z' }, foreignRef)), 'utf8');

  const owned = await boundedCleanup({
    pid: null, worktreeDir: null, workspace: null, pr: null,
    lockFile: ownedFile, lockOwner: ownerRef, liveness, log: () => {}, gracefulShutdownMs: 0,
  });
  assert.equal(owned.leaseReleased, true);
  assert.ok(!fs.existsSync(ownedFile));

  const foreign = await boundedCleanup({
    pid: null, worktreeDir: null, workspace: null, pr: null,
    lockFile: foreignFile, lockOwner: ownerRef, liveness, log: () => {}, gracefulShutdownMs: 0,
  });
  assert.equal(foreign.leaseReleased, false);
  assert.ok(fs.existsSync(foreignFile), '別所有者のmanager.runningを残す');
});

// ── superviseReviewManager: setupReviewWorktree 失敗時の記録 ──────────────

test('superviseReviewManager: setupReviewWorktree失敗時にsetup-failedで戻りロックを記録して起動予約を解放する', async () => {
  const testDir = path.join(tmpBase, 'sv-error-imm');
  fs.mkdirSync(testDir, { recursive: true });

  const ghDir = path.join(testDir, '.gh-maestro');
  const logFile = path.join(testDir, 'rm.log');
  const promptFile = path.join(testDir, 'prompt.md');
  const lockFile = path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.running');
  const startingFile = reviewManagerStartingPath(lockFile);
  const outputFile = path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.json');

  const logs = [];
  const log = (msg) => logs.push(msg);

  // 起動側が先に作った予約を、本体がmanager.runningを書いた直後に解放する
  // 順序を模擬する（PR #410の二重writer回帰）。
  const startupToken = 'startup-token-for-test';
  fs.mkdirSync(path.dirname(startingFile), { recursive: true });
  fs.writeFileSync(startingFile, JSON.stringify({
    pid: process.pid,
    startTime: null,
    token: startupToken,
  }), 'utf8');
  const previousStartupToken = process.env.GH_MAESTRO_REVIEW_MANAGER_STARTUP_TOKEN;
  process.env.GH_MAESTRO_REVIEW_MANAGER_STARTUP_TOKEN = startupToken;

  let result;
  try {
    result = await superviseReviewManager({
      pr: '999', repo: 'o/r', workspace: testDir,
      ghDir, lockFile, logFile, outputFile, promptFile,
      deadlineMs: 30000,
      log,
      signal: { aborted: false },
    });
  } finally {
    if (previousStartupToken === undefined) {
      delete process.env.GH_MAESTRO_REVIEW_MANAGER_STARTUP_TOKEN;
    } else {
      process.env.GH_MAESTRO_REVIEW_MANAGER_STARTUP_TOKEN = previousStartupToken;
    }
  }
  // エラー結果であること
  assert.equal(result.outcome, 'setup-failed');
  assert.notEqual(result.exitCode, 0);
  const marker = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(marker.pid, process.pid);
  assert.ok(marker.startTime === null || typeof marker.startTime === 'string');
  assert.equal(fs.existsSync(startingFile), false, '本体書き込み後に自分の起動予約を解放する');
});

// ── Issue #248 項目4: clearStaleIncompleteSentinel ─────────────────────────
// 再レビュー周回の開始（superviseReviewManager ステップ1）で、前周回の古い
// .incomplete センチネルを消す。残っていると新周回の途中結果を「不完全完了」と
// 誤判定してしまう。

test('clearStaleIncompleteSentinel: 存在するセンチネルを削除する', () => {
  const testDir = path.join(tmpBase, 'stale-sentinel-exists');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const sentinel = path.join(ghDir, 'records', 'pr', '123', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'done');
  clearStaleIncompleteSentinel(testDir, 123);
  assert.ok(!fs.existsSync(sentinel), 'sentinel should be removed');
});

test('clearStaleIncompleteSentinel: 存在しなければno-op（エラーにしない）', () => {
  const testDir = path.join(tmpBase, 'stale-sentinel-missing');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  // 例外が投げられなければok
  clearStaleIncompleteSentinel(testDir, 456);
});

test('clearStaleIncompleteSentinel: 別PRのセンチネルは残す', () => {
  const testDir = path.join(tmpBase, 'stale-sentinel-other');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const other = path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, 'done');
  clearStaleIncompleteSentinel(testDir, 123);
  assert.ok(fs.existsSync(other), 'unrelated PR sentinel should remain');
});

// ── Issue #273: resetRetryCount（再試行カウンタの周回開始リセット） ─────────
// 新レビュー周回の開始（superviseReviewManager ステップ1）で、前周回の再試行カウンタを消す。
// 残っていると新周回が最初から「上限到達」と誤判定される（受け入れ条件「新しいレビューが
// 始まるときには回数がリセットされ、前のレビューの回数を引きずらない」）。

test('resetRetryCount: 存在するカウンタを削除する', () => {
  const testDir = path.join(tmpBase, 'reset-retry-exists');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const counter = path.join(ghDir, 'records', 'pr', '123', 'review', 'manager.retries.json');
  fs.mkdirSync(path.dirname(counter), { recursive: true });
  fs.writeFileSync(counter, '{"attempts":2}');
  resetRetryCount(testDir, 123);
  assert.ok(!fs.existsSync(counter), 'counter should be removed');
});

test('resetRetryCount: 存在しなければno-op（エラーにしない）', () => {
  const testDir = path.join(tmpBase, 'reset-retry-missing');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  resetRetryCount(testDir, 456); // 例外が投げられなければok
});

test('resetRetryCount: 別PRのカウンタは残す', () => {
  const testDir = path.join(tmpBase, 'reset-retry-other');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const other = path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.retries.json');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, '{"attempts":2}');
  resetRetryCount(testDir, 123);
  assert.ok(fs.existsSync(other), 'unrelated PR counter should remain');
});

test('resetRetryCount: 削除失敗（ディレクトリ等）は throw する（フェイルクローズ、Issue #273 レビュー指摘）', () => {
  const testDir = path.join(tmpBase, 'reset-retry-fail');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  // カウンタパスを「ディレクトリ」として作ることで unlinkSync を失敗させる
  // （unlinkSync はディレクトリを削除できない。Windows では EPERM/EACCES）。
  const counter = path.join(ghDir, 'records', 'pr', '123', 'review', 'manager.retries.json');
  fs.mkdirSync(counter, { recursive: true });
  assert.throws(
    () => resetRetryCount(testDir, 123),
    /再試行カウンタのリセットに失敗しました/,
  );
});

// ── Issue #271: センチネル検出（main/worktree両方）と manifest 永続化 ─────────
// 検証失敗時に run-review-jobs.js が worktree 側へ書く .incomplete センチネルも
// 検出できること（main側だけ見ると黙って process-exit-no-artifact になる）、および
// boundedCleanup が worktree を破壊する前に manifest を main の record へ退避できることを
// 検証する。

test('findIncompleteSentinel: メインworkspaceのセンチネルを検出する', () => {
  const testDir = path.join(tmpBase, 'sentinel-main');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const mainSentinel = path.join(ghDir, 'records', 'pr', '321', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(mainSentinel), { recursive: true });
  fs.writeFileSync(mainSentinel, '{}', 'utf8');

  const found = findIncompleteSentinel(testDir, path.join(testDir, 'wt'), 321);
  assert.equal(found, mainSentinel);
});

test('findIncompleteSentinel: worktree側のセンチネルも検出する（Issue #271）', () => {
  const testDir = path.join(tmpBase, 'sentinel-wt');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  // worktree側にだけセンチネル（manifest検証失敗時に run-review-jobs.js が書く場所）
  const wtDir = path.join(testDir, 'wt');
  const wtSentinel = path.join(wtDir, '.gh-maestro', 'records', 'pr', '654', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(wtSentinel), { recursive: true });
  fs.writeFileSync(wtSentinel, '{}', 'utf8');

  const found = findIncompleteSentinel(testDir, wtDir, 654);
  assert.equal(found, wtSentinel);
});

test('findIncompleteSentinel: mainを優先し、どちらにも無ければnull', () => {
  const testDir = path.join(tmpBase, 'sentinel-priority');
  fs.mkdirSync(testDir, { recursive: true });
  const ghDir = path.join(testDir, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const wtDir = path.join(testDir, 'wt');

  // 両方に存在 → main側を返す
  const mainSentinel = path.join(ghDir, 'records', 'pr', '777', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(mainSentinel), { recursive: true });
  fs.writeFileSync(mainSentinel, '{}', 'utf8');
  const wtSentinel = path.join(wtDir, '.gh-maestro', 'records', 'pr', '777', 'review', 'manager.incomplete');
  fs.mkdirSync(path.dirname(wtSentinel), { recursive: true });
  fs.writeFileSync(wtSentinel, '{}', 'utf8');
  assert.equal(findIncompleteSentinel(testDir, wtDir, 777), mainSentinel);

  // どちらにも存在しない → null
  assert.equal(findIncompleteSentinel(testDir, wtDir, 999), null);
  // reviewWtDir が null でも例外を投げず main だけ確認する
  assert.equal(findIncompleteSentinel(testDir, null, 999), null);
});

test('persistReviewManifest: worktreeのrecordsパスからmainのrecordへ永続化する', () => {
  const testDir = path.join(tmpBase, 'persist-records');
  fs.mkdirSync(testDir, { recursive: true });
  const workspace = testDir;
  const wtDir = path.join(testDir, 'wt');
  const manifestContent = JSON.stringify({ pr: 111, repo: 'o/r', acceptanceCriteria: ['条件A', '条件B'] });

  // worktree側 records パスにmanifestを用意（改訂後のSKILL.mdが書く場所）
  const srcManifest = path.join(wtDir, '.gh-maestro', 'records', 'pr', '111', 'review', 'manifest.json');
  fs.mkdirSync(path.dirname(srcManifest), { recursive: true });
  fs.writeFileSync(srcManifest, manifestContent, 'utf8');

  const logs = [];
  const result = persistReviewManifest({ reviewWtDir: wtDir, workspace, pr: 111, log: (m) => logs.push(m) });

  const target = path.join(workspace, '.gh-maestro', 'records', 'pr', '111', 'review', 'manifest.json');
  assert.equal(result.persisted, true);
  assert.equal(result.sourcePath, srcManifest);
  assert.equal(result.targetPath, target);
  assert.equal(fs.readFileSync(target, 'utf8'), manifestContent);
});

test('persistReviewManifest: legacyパス（review-manifest-<PR>.json）からも取り込む', () => {
  const testDir = path.join(tmpBase, 'persist-legacy');
  fs.mkdirSync(testDir, { recursive: true });
  const workspace = testDir;
  const wtDir = path.join(testDir, 'wt');
  const manifestContent = JSON.stringify({ pr: 222, repo: 'o/r', acceptanceCriteria: ['x'] });

  const srcLegacy = path.join(wtDir, '.gh-maestro', 'review-manifest-222.json');
  fs.mkdirSync(path.dirname(srcLegacy), { recursive: true });
  fs.writeFileSync(srcLegacy, manifestContent, 'utf8');

  const result = persistReviewManifest({ reviewWtDir: wtDir, workspace, pr: 222, log: () => {} });
  assert.equal(result.persisted, true);
  assert.equal(result.sourcePath, srcLegacy);
  const target = path.join(workspace, '.gh-maestro', 'records', 'pr', '222', 'review', 'manifest.json');
  assert.equal(fs.readFileSync(target, 'utf8'), manifestContent);
});

test('persistReviewManifest: 候補が無ければpersisted:false（エラーにしない）', () => {
  const testDir = path.join(tmpBase, 'persist-none');
  fs.mkdirSync(testDir, { recursive: true });
  const result = persistReviewManifest({ reviewWtDir: path.join(testDir, 'wt'), workspace: testDir, pr: 333, log: () => {} });
  assert.equal(result.persisted, false);
  assert.equal(result.sourcePath, null);

  // reviewWtDir が null でも例外を投げない
  const nullWt = persistReviewManifest({ reviewWtDir: null, workspace: testDir, pr: 334, log: () => {} });
  assert.equal(nullWt.persisted, false);
  assert.equal(nullWt.sourcePath, null);
});

// ── PR #272 レビュー指摘: notify-failedセンチネルは失敗として観測する ──────
// 欠陥Aの監督側: run-review-jobs.js が検証失敗通知のPR投稿に失敗したとき、
// 投稿成功センチネル（incomplete-review）を exit 0 の「不完全完了」として扱うと、
// オーケストレーターが通知済みと誤認する。notify-failed は exit 1 の失敗にする。

test('incompleteSentinelOutcome: notify-failed センチネルは exit 1 の失敗として返す', () => {
  const testDir = path.join(tmpBase, 'sentinel-notify-failed');
  fs.mkdirSync(testDir, { recursive: true });
  const sentinelPath = reviewArtifactPath(testDir, 42, '.incomplete');
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, JSON.stringify({
    pr: 42,
    reason: 'notify-failed',
    postError: 'auth failed: token expired',
    failureLabel: 'パースエラー',
    failureDetail: 'manifest JSON parse failed: Unexpected token } in JSON at position 12 (path: /wt/manifest.json)',
    completed_at: 'x',
  }), 'utf8');

  const result = incompleteSentinelOutcome({ sentinelPath, agentPid: 123, reviewWtDir: '/wt' });
  assert.equal(result.outcome, 'incomplete-review-notify-failed');
  assert.equal(result.exitCode, 1);
  // orchestratorが投稿失敗と失敗内容（failureLabel/failureDetail）の両方を確認できるように理由に含める
  assert.ok(result.reason.includes('auth failed: token expired'), `reason should carry postError: ${result.reason}`);
  assert.ok(result.reason.includes('パースエラー'), `reason should carry failureLabel: ${result.reason}`);
  assert.ok(result.reason.includes('manifest JSON parse failed'), `reason should carry failureDetail: ${result.reason}`);
});

test('incompleteSentinelOutcome: 旧形式（validationErrors配列のみ）センチネルもフォールバック表示する', () => {
  const testDir = path.join(tmpBase, 'sentinel-notify-failed-old');
  fs.mkdirSync(testDir, { recursive: true });
  const sentinelPath = reviewArtifactPath(testDir, 45, '.incomplete');
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  // 前回マージ時点の notify-failed センチネル形式（validationErrors のみ）。互換のため読めること
  fs.writeFileSync(sentinelPath, JSON.stringify({
    pr: 45,
    reason: 'notify-failed',
    postError: 'network error',
    validationErrors: ['leaf x is missing from coverage_ledger', 'pr must be a positive integer'],
    completed_at: 'x',
  }), 'utf8');

  const result = incompleteSentinelOutcome({ sentinelPath, agentPid: null, reviewWtDir: '/wt' });
  assert.equal(result.outcome, 'incomplete-review-notify-failed');
  assert.equal(result.exitCode, 1);
  assert.ok(result.reason.includes('検証エラー: leaf x is missing from coverage_ledger'), `fallback detail: ${result.reason}`);
  assert.ok(result.reason.includes('pr must be a positive integer'), `all validationErrors joined: ${result.reason}`);
});

test('incompleteSentinelOutcome: 通知済み（incomplete-review）センチネルは exit 0 の不完全完了', () => {
  const testDir = path.join(tmpBase, 'sentinel-incomplete-ok');
  fs.mkdirSync(testDir, { recursive: true });
  const sentinelPath = reviewArtifactPath(testDir, 43, '.incomplete');
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, JSON.stringify({ pr: 43, reason: 'incomplete-review', completed_at: 'x' }), 'utf8');

  const result = incompleteSentinelOutcome({ sentinelPath, agentPid: 456, reviewWtDir: '/wt' });
  assert.equal(result.outcome, 'incomplete-review');
  assert.equal(result.exitCode, 0);
});

test('readIncompleteSentinel: 解釈できないセンチネルは null（notify-failed判定にしない）', () => {
  const testDir = path.join(tmpBase, 'sentinel-unreadable');
  fs.mkdirSync(testDir, { recursive: true });
  const sentinelPath = reviewArtifactPath(testDir, 44, '.incomplete');
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  fs.writeFileSync(sentinelPath, 'not-json', 'utf8');

  assert.equal(readIncompleteSentinel(sentinelPath), null);
  // 解釈できない場合は notify-failed ではなく通常の不完全完了扱いになる
  const result = incompleteSentinelOutcome({ sentinelPath, agentPid: null, reviewWtDir: null });
  assert.equal(result.outcome, 'incomplete-review');
  assert.equal(result.exitCode, 0);
});
