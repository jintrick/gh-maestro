'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const { cleanSpawnEnv } = require('../_spawn-env');

const {
  validateManifest,
  validateJobs,
  resolveReviewSkillsDir,
  resolveCanonicalReviewPath,
  readJobLeaves,
  buildJobPrompt,
  launchJobWorker,
  runJobsFromManifest,
  buildManifestValidationComment,
  buildManifestLoadFailureComment,
  notifyManifestValidationFailure,
  notifyManifestProblem,
  resolveNotifyPr,
  retryCountPath,
  retryCountLockPath,
  acquireRetryCountLock,
  releaseRetryCountLock,
  _setRetryCountLockWaitMs,
  readRetryCount,
  incrementRetryCount,
  applyRetryGate,
  MAX_REVIEW_ATTEMPTS,
  resolveRunJobsExitCode,
  _setGhForTest,
  _setFinalizeReviewForTest,
  _setSpawn,
} = require('../../scripts/run-review-jobs');

const {
  ALL_LEAF_IDS,
  REVIEW_ASPECT_FILES,
  reviewFilesForLeaves,
  TRUNK_TO_LEAVES,
} = require('../../scripts/shared/review-aspects');
const { reviewArtifactPath } = require('../../scripts/shared/review-manager-paths');
const { managedRoot } = require('../../scripts/shared/storage-layout');

function writeReviewFixtures(root, leafIds, contents = {}) {
  for (const file of reviewFilesForLeaves(leafIds)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents[file] || `# Canonical ${file}`, 'utf8');
  }
}

function shellCommandText(call) {
  if (process.platform === 'win32') {
    return Buffer.from(call.args[2], 'base64').toString('utf16le');
  }
  return call.args.slice(3).join(' ');
}

function resultFileFromPrompt(prompt) {
  const match = prompt.match(/結果ファイル:\s*`([^`]+)`/);
  assert.ok(match, 'review prompt should specify a result file');
  return path.normalize(match[1]);
}

function codexReviewAgentConfig() {
  return {
    id: 'codex',
    command: 'codex',
    execArgs: ['exec', '--skip-git-repo-check', '--cd', '{workspace}', '--dangerously-bypass-approvals-and-sandbox'],
    extraArgs: ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'],
    nonInteractiveTokens: ['exec'],
    promptDelivery: 'positional',
  };
}

async function runReviewJobWithResult(resultText, options = {}) {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gjpm-result-wt-'));
  const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gjpm-result-skills-'));
  const calls = [];
  let promptText;
  let resultFilePath;
  const finding = {
    aspect: 'Correctness',
    path: 'src/a.js',
    line_anchor: 'return value',
    summary: 'A finding',
    severity: 'SUGGESTION',
    severity_rationale: 'verified',
    body: 'body',
    verified_references: ['src/a.js'],
  };
  writeReviewFixtures(skillsDir, ['correctness/logic-invariants']);

  _setSpawn((command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      const promptFile = fs.readdirSync(os.tmpdir())
        .filter(name => name.startsWith('review-job-job-1-review-') && name.endsWith('.md'))
        .map(name => path.join(os.tmpdir(), name))
        .sort()
        .pop();
      assert.ok(promptFile, 'review prompt file should exist while the process runs');
      promptText = fs.readFileSync(promptFile, 'utf8');
      resultFilePath = resultFileFromPrompt(promptText);
      if (resultText !== undefined) fs.writeFileSync(resultFilePath, resultText, 'utf8');
      child.stdout.emit('data', Buffer.from(options.stdout || 'agent progress and JSONL events'));
      child.emit('close', 0);
    });
    return child;
  });

  try {
    const result = await launchJobWorker(
      { id: 'job-1', leaf_ids: ['correctness/logic-invariants'], aspect: 'Correctness' },
      { pr: 123, repo: 'o/r', headRefOid: 'abc', changedFiles: ['src/a.js'] },
      options.agentConfig || codexReviewAgentConfig(),
      worktreeDir,
      worktreeDir,
      5000,
      null,
      { reviewSkillsDir: skillsDir },
    );
    return { result, calls, promptText, resultFilePath, finding };
  } finally {
    _setSpawn(null);
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    fs.rmSync(skillsDir, { recursive: true, force: true });
  }
}































// ── Issue #271: manifest検証失敗の通知 ─────────────────────────────────────────
// 実行manifestの機械検証に失敗した場合、検証エラーをPRへのプレーンコメントと
// .incomplete センチネルで通知し、そのまま終了する（ヘッドレス再試行はしない）。
// 冪等性・NODE_TEST_CONTEXTガード・gh注入（実プロセス0個）を検証する。







// ── PR #272 レビュー指摘の回帰テスト ─────────────────────────────────────────
// 欠陥A: 投稿失敗時も成功センチネルを書いていた → 通知成功を偽装 + 冪等ガードが再投稿を塞ぐ
// 欠陥B: manifest.pr が不正（0・欠落）だと reviewArtifactPath が throw し、コメントも
//   センチネルも書かれず黙って終わっていた







// ── 追加対応（orchestrator指示）: --pr/--repo必須化と読み込み・パース失敗の通知統合 ──
// 積み残しだった「manifest JSONパース失敗」「読み込み失敗」も同じ通知経路（PRコメント＋
// センチネル）へ流す。manifest.pr / manifest.repo は取れないため、CLI --pr / --repo が通知先。








test('CLI: --help は exit 0、--pr / --repo の用途エラーは exit 1（クラッシュさせない）', () => {
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'run-review-jobs.js');
  const baseArgs = ['--manifest', 'm.json', '--results', 'r.json'];
  const run = (args) => spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env: cleanSpawnEnv(),
  });

  const help = run(['--help']);
  assert.equal(help.status, 0, `--help は exit 0: ${help.stderr}`);
  assert.match(help.stdout, /run-review-jobs\.js/);

  // --pr 欠落 → exit 1 の明確なメッセージ（parseFlags は必須欠落を ArgsValidationError で
  // throw するため、null.trim() 等の TypeError クラッシュにしないことが本テストの趣旨）
  const noPr = run([...baseArgs, '--repo', 'o/r']);
  assert.equal(noPr.status, 1, `--pr 欠落は exit 1: ${noPr.stderr}`);
  assert.match(noPr.stderr, /必須フラグがありません: --pr/);

  // --pr 不正（非正整数）→ exit 1（--gh-dir は必須化されているため併せて渡す）
  const badPr = run([...baseArgs, '--pr', 'abc', '--repo', 'o/r', '--gh-dir', 'g']);
  assert.equal(badPr.status, 1, `--pr 不正は exit 1: ${badPr.stderr}`);
  assert.match(badPr.stderr, /--pr は正整数でなければなりません/);

  // --repo 欠落 → exit 1（TypeError クラッシュにならないこと）
  const noRepo = run([...baseArgs, '--pr', '42']);
  assert.equal(noRepo.status, 1, `--repo 欠落は exit 1（クラッシュではない）: ${noRepo.stderr}`);
  assert.match(noRepo.stderr, /必須フラグがありません: --repo/);
  assert.doesNotMatch(noRepo.stderr, /TypeError/);

  // --gh-dir 欠落 → exit 1（Issue #273。--repo と同型のクラッシュにしないこと）
  const noGhDir = run([...baseArgs, '--pr', '42', '--repo', 'o/r']);
  assert.equal(noGhDir.status, 1, `--gh-dir 欠落は exit 1（クラッシュではない）: ${noGhDir.stderr}`);
  assert.match(noGhDir.stderr, /必須フラグがありません: --gh-dir/);
  assert.doesNotMatch(noGhDir.stderr, /TypeError/);
});

// ── Issue #273: 再試行カウンタ（決定的上限） ───────────────────────────────────
