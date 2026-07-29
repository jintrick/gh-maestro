'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  ROLE_LABEL_MAP,
  buildWorkerName,
  buildNormalWorkerLaunchSpec,
  buildReviewManagerLaunchSpec,
  normalWorkerPolicy,
  reviewManagerPolicy,
} = require('../scripts/shared/worker-factory');

const { workerLogPath } = require('../scripts/shared/headless-launch');
const {
  reviewWorktreeBranchName,
  reviewArtifactPath,
} = require('../scripts/shared/review-manager-paths');

// ── ROLE_LABEL_MAP ─────────────────────────────────────────────────────────────

test('ROLE_LABEL_MAP: 全既知スキルが登録されている', () => {
  const expected = [
    'gh-maestro-coder',
    'gh-maestro-senior-coder',
    'gh-maestro-explorer',
    'gh-maestro-investigator',
    'gh-maestro-architect',
    'gh-maestro-base',
    'gh-maestro-reviewer',
  ];
  for (const skill of expected) {
    assert.ok(ROLE_LABEL_MAP[skill], `skill "${skill}" が ROLE_LABEL_MAP に存在すること`);
    assert.equal(typeof ROLE_LABEL_MAP[skill], 'string');
    assert.ok(ROLE_LABEL_MAP[skill].length > 0, `role for "${skill}" が空でないこと`);
  }
});

test('ROLE_LABEL_MAP: 各ロールラベルが一意である', () => {
  const roles = Object.values(ROLE_LABEL_MAP);
  const unique = new Set(roles);
  assert.equal(unique.size, roles.length, '全ロールラベルが一意であること');
});

test('ROLE_LABEL_MAP: 全ロールラベルが英数字・ハイフンのみで構成される', () => {
  for (const [skill, role] of Object.entries(ROLE_LABEL_MAP)) {
    assert.match(role, /^[a-z][a-z-]*$/, `role "${role}" (skill: ${skill}) が小文字・ハイフンのみであること`);
  }
});

test('ROLE_LABEL_MAP: gh-maestro-reviewer → review-manager', () => {
  assert.equal(ROLE_LABEL_MAP['gh-maestro-reviewer'], 'review-manager');
});

test('ROLE_LABEL_MAP: gh-maestro-senior-coder → senior-coder', () => {
  assert.equal(ROLE_LABEL_MAP['gh-maestro-senior-coder'], 'senior-coder');
});

test('ROLE_LABEL_MAP: gh-maestro-coder → coder', () => {
  assert.equal(ROLE_LABEL_MAP['gh-maestro-coder'], 'coder');
});

// ── buildWorkerName ────────────────────────────────────────────────────────────

test('buildWorkerName: 正規形式 issue-<issue>-<role>-<description> を組み立てる', () => {
  assert.equal(buildWorkerName(5, 'coder', 'fix-auth'), 'issue-5-coder-fix-auth');
  assert.equal(buildWorkerName(174, 'senior-coder', 'factory-lease'), 'issue-174-senior-coder-factory-lease');
  assert.equal(buildWorkerName(10, 'explorer', 'investigate-deps'), 'issue-10-explorer-investigate-deps');
  assert.equal(buildWorkerName(3, 'review-manager', 'pr-42'), 'issue-3-review-manager-pr-42');
});

test('buildWorkerName: descriptionにハイフンを含む場合も正しく組み立てる', () => {
  assert.equal(
    buildWorkerName(5, 'coder', 'fix-auth-bug'),
    'issue-5-coder-fix-auth-bug',
  );
});

test('buildWorkerName: descriptionにアンダースコアを含む場合も正しく組み立てる', () => {
  assert.equal(
    buildWorkerName(7, 'investigator', 'crash_on_startup_v2'),
    'issue-7-investigator-crash_on_startup_v2',
  );
});

// ── buildNormalWorkerLaunchSpec ────────────────────────────────────────────────

test('buildNormalWorkerLaunchSpec: 各フィールドが正しく設定される', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'owner/repo',
    workspace: 'C:/ws',
  });

  assert.equal(spec.workerName, 'issue-5-coder-fix-auth');
  assert.equal(spec.issue, 5);
  assert.equal(typeof spec.issue, 'number');
  assert.equal(spec.role, 'coder');
  assert.equal(spec.skill, 'gh-maestro-coder');
  assert.equal(spec.description, 'fix-auth');
  assert.equal(spec.pr, null);
  assert.equal(spec.repo, 'owner/repo');
  assert.equal(spec.workspace, 'C:/ws');
});

test('buildNormalWorkerLaunchSpec: issue は文字列でも数値に変換される', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-investigator',
    issue: '42',
    description: 'debug-crash',
    repo: 'o/r',
    workspace: '/ws',
  });
  assert.equal(spec.issue, 42);
  assert.equal(typeof spec.issue, 'number');
});

test('buildNormalWorkerLaunchSpec: worktreeKey は workerName と同一', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: '/ws',
  });
  assert.equal(spec.worktreeKey, spec.workerName);
  assert.equal(spec.worktreeKey, 'issue-5-coder-fix-auth');
});

test('buildNormalWorkerLaunchSpec: worktreeDir は .gh-maestro/worktrees/<worktreeKey>', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });
  assert.equal(
    spec.worktreeDir,
    path.join('C:/ws', '.gh-maestro', 'worktrees', 'issue-5-coder-fix-auth'),
  );
});

test('buildNormalWorkerLaunchSpec: logKey は workerName と同一', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-senior-coder',
    issue: 174,
    description: 'factory-lease',
    repo: 'o/r',
    workspace: '/ws',
  });
  assert.equal(spec.logKey, spec.workerName);
  assert.equal(spec.logKey, 'issue-174-senior-coder-factory-lease');
});

test('buildNormalWorkerLaunchSpec: logPath は workerLogPath(workspace, workerName)', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });
  const expected = workerLogPath('C:/ws', 'issue-5-coder-fix-auth');
  assert.equal(spec.logPath, expected);
  assert.match(spec.logPath, /worker-logs[/\\]issue-5-coder-fix-auth\.log$/);
});

test('buildNormalWorkerLaunchSpec: leaseKey は workerName と同一（workers.jsonのキー）', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });
  assert.equal(spec.leaseKey, spec.workerName);
  assert.equal(spec.leaseKey, 'issue-5-coder-fix-auth');
});

test('buildNormalWorkerLaunchSpec: leaseStore は workers.json のパス', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });
  assert.equal(
    spec.leaseStore,
    path.join('C:/ws', '.gh-maestro', 'workers.json'),
  );
});

test('buildNormalWorkerLaunchSpec: 全通常ワーカースキルで起動仕様を生成できる', () => {
  const normalSkills = [
    'gh-maestro-coder',
    'gh-maestro-senior-coder',
    'gh-maestro-explorer',
    'gh-maestro-investigator',
    'gh-maestro-architect',
    'gh-maestro-base',
  ];

  for (const skill of normalSkills) {
    const spec = buildNormalWorkerLaunchSpec({
      skill,
      issue: 1,
      description: 'test-desc',
      repo: 'o/r',
      workspace: '/ws',
    });
    assert.equal(spec.skill, skill);
    assert.ok(spec.workerName.includes(ROLE_LABEL_MAP[skill]), `workerName should include role for ${skill}`);
    assert.equal(spec.pr, null);
    assert.equal(spec.worktreeKey, spec.workerName);
  }
});

// ── buildNormalWorkerLaunchSpec エラーケース ───────────────────────────────────

test('buildNormalWorkerLaunchSpec: 未知のスキルはエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-unknown-role',
      issue: 1,
      description: 'test',
      repo: 'o/r',
      workspace: '/ws',
    }),
    /未知のスキル/,
  );
});

test('buildNormalWorkerLaunchSpec: review-manager スキルは通常ワーカーとして拒否される', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-reviewer',
      issue: 1,
      description: 'test',
      repo: 'o/r',
      workspace: '/ws',
    }),
    /review-manager/,
  );
});

// ── buildReviewManagerLaunchSpec ───────────────────────────────────────────────

test('buildReviewManagerLaunchSpec: 各フィールドが正しく設定される', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174,
    pr: '42',
    repo: 'owner/repo',
    workspace: 'C:/ws',
  });

  assert.equal(spec.workerName, 'issue-174-review-manager-pr-42');
  assert.equal(spec.issue, 174);
  assert.equal(typeof spec.issue, 'number');
  assert.equal(spec.role, 'review-manager');
  assert.equal(spec.skill, 'gh-maestro-reviewer');
  assert.equal(spec.description, 'pr-42');
  assert.equal(spec.pr, '42');
  assert.equal(spec.repo, 'owner/repo');
  assert.equal(spec.workspace, 'C:/ws');
});

test('buildReviewManagerLaunchSpec: pr は文字列/数値どちらでも受け付ける', () => {
  const specStr = buildReviewManagerLaunchSpec({
    issue: 1, pr: '99', repo: 'o/r', workspace: '/ws',
  });
  assert.equal(specStr.pr, '99');

  const specNum = buildReviewManagerLaunchSpec({
    issue: 1, pr: 99, repo: 'o/r', workspace: '/ws',
  });
  assert.equal(specNum.pr, '99');
});

test('buildReviewManagerLaunchSpec: workerName は issue-<issue>-review-manager-pr-<pr> 形式', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 55, pr: '7', repo: 'o/r', workspace: '/ws',
  });
  // 現行 start-review-manager.js が GH_MAESTRO_WORKER に設定する値と一致すること
  assert.equal(spec.workerName, 'issue-55-review-manager-pr-7');
});

test('buildReviewManagerLaunchSpec: worktreeKey は review-pr-<pr>（workerName とは異なる）', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: '/ws',
  });
  assert.equal(spec.worktreeKey, 'review-pr-42');
  assert.notEqual(spec.worktreeKey, spec.workerName);
});

test('buildReviewManagerLaunchSpec: worktreeKey は reviewWorktreeBranchName(pr) と一致する', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: '/ws',
  });
  assert.equal(spec.worktreeKey, reviewWorktreeBranchName('42'));
});

test('buildReviewManagerLaunchSpec: worktreeDir は .gh-maestro/worktrees/review-pr-<pr>', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: 'C:/ws',
  });
  assert.equal(
    spec.worktreeDir,
    path.join('C:/ws', '.gh-maestro', 'worktrees', 'review-pr-42'),
  );
});

test('buildReviewManagerLaunchSpec: logKey は正規ID（workerName）', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: '/ws',
  });
  assert.equal(spec.logKey, spec.workerName);
  assert.equal(spec.logKey, 'issue-174-review-manager-pr-42');
});

test('buildReviewManagerLaunchSpec: logPath は workerLogPath(workspace, workerName)（正規ID経由）', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: 'C:/ws',
  });
  const expected = workerLogPath('C:/ws', 'issue-174-review-manager-pr-42');
  assert.equal(spec.logPath, expected);
});

test('buildReviewManagerLaunchSpec: leaseKey は review-manager-<pr>（.runningのベース名）', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: '/ws',
  });
  assert.equal(spec.leaseKey, 'review-manager-42');
});

test('buildReviewManagerLaunchSpec: leaseStore は reviewArtifactPath(ghDir, pr, ".running") と一致する', () => {
  const workspace = 'C:/ws';
  const ghDir = path.join(workspace, '.gh-maestro');
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace,
  });

  const expected = reviewArtifactPath(ghDir, '42', '.running');
  assert.equal(spec.leaseStore, expected);
  assert.match(spec.leaseStore, /review-manager-42\.running$/);
});

test('buildReviewManagerLaunchSpec: PR番号が無効だとエラー（path traversal対策）', () => {
  assert.throws(
    () => buildReviewManagerLaunchSpec({
      issue: 1, pr: '../../evil', repo: 'o/r', workspace: '/ws',
    }),
    /invalid PR number/,
  );
});

test('buildReviewManagerLaunchSpec: issue は文字列でも数値に変換される', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: '55', pr: '7', repo: 'o/r', workspace: '/ws',
  });
  assert.equal(spec.issue, 55);
  assert.equal(typeof spec.issue, 'number');
});

// ── 現行実装との一致検証 ───────────────────────────────────────────────────────
// factoryが返す値が、現行の spawn-worker.js / start-review-manager.js /
// run-review-manager.js / review-manager-paths.js がハードコードしている値と
// 一致することを検証する。

test('現行一致: 通常ワーカーのworktreeKeyがspawn-worker.jsのworktreeDir末尾と一致する', () => {
  // spawn-worker.js line 218:
  //   const worktreeDir = resolve(workspace, '.gh-maestro', 'worktrees', workerName);
  // 旧workerName（issue-<issue>-<description>）は本factoryでは
  // issue-<issue>-<role>-<description> に変更される。
  // worktreeKeyは新しいworkerNameと同一であり、spawn-worker.jsが
  // worktreeDirを組み立てる際のベース名として使えることを確認する。
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });

  // 現行の spawn-worker.js がこのworkerNameでworktreeDirを組み立てた場合
  const currentStyleWorktreeDir = path.join(
    'C:/ws', '.gh-maestro', 'worktrees',
    'issue-5-coder-fix-auth', // ← 新しい正規ID
  );
  assert.equal(spec.worktreeDir, currentStyleWorktreeDir);
  // ベース名（ディレクトリ名）が worktreeKey と一致する
  assert.equal(path.basename(spec.worktreeDir), spec.worktreeKey);
});

test('現行一致: Review ManagerのworkerNameがstart-review-manager.jsのGH_MAESTRO_WORKERと一致する', () => {
  // start-review-manager.js line 102:
  //   const workerName = `issue-${issue}-review-manager-pr-${pr}`;
  const spec = buildReviewManagerLaunchSpec({
    issue: 55, pr: '7', repo: 'o/r', workspace: '/ws',
  });
  // 現行コードと完全に一致
  assert.equal(spec.workerName, 'issue-55-review-manager-pr-7');
});

test('現行一致: Review ManagerのleaseStoreがstart-review-manager.jsのlockFileと一致する', () => {
  // start-review-manager.js line 92:
  //   const lockFile = reviewArtifactPath(ghDir, pr, '.running');
  const workspace = 'C:/ws';
  const ghDir = path.join(workspace, '.gh-maestro');

  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace,
  });

  // 現行コードの lockFile 構築と完全に一致
  const expectedLockFile = reviewArtifactPath(ghDir, '42', '.running');
  assert.equal(spec.leaseStore, expectedLockFile);
});

test('現行一致: Review ManagerのworktreeKeyがrun-review-manager.jsのworktreeブランチ名と一致する', () => {
  // run-review-manager.js → review-manager-paths.js:
  //   reviewWorktreeBranchName(pr) → review-pr-<pr>
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: '/ws',
  });

  assert.equal(spec.worktreeKey, reviewWorktreeBranchName('42'));
  assert.equal(spec.worktreeKey, 'review-pr-42');
});

test('現行一致: 通常ワーカーのlogKeyがworkerLogPathの第二引数として使える', () => {
  // spawn-worker.js line 398:
  //   const logPath = workerLogPath(workspace, workerName);
  // 現行は旧workerName（issue-<issue>-<description>）を使っている。
  // factoryのlogKey（正規ID）を workerLogPath に渡した場合のパスを確認する。
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });

  const logPath = workerLogPath('C:/ws', spec.logKey);
  assert.equal(logPath, spec.logPath);
  assert.match(logPath, /worker-logs[/\\]issue-5-coder-fix-auth\.log$/);
});

test('現行一致: Review Managerのfindings成果物キーはreview-manager-<pr>で変わらない', () => {
  // review-manager-paths.js:
  //   reviewArtifactPath(ghDir, pr, '.json') → <ghDir>/review-manager-<pr>.json
  // このキーはfactoryのleaseKeyと同一のベース名（review-manager-<pr>）を使う。
  const workspace = 'C:/ws';
  const ghDir = path.join(workspace, '.gh-maestro');
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace,
  });

  // findings JSON のパス（現行のまま）
  const findingsPath = reviewArtifactPath(ghDir, '42', '.json');
  assert.equal(findingsPath, path.join(ghDir, 'review-manager-42.json'));
  // leaseKey が findings 成果物と同一のベース名であることを確認
  assert.ok(findingsPath.includes(spec.leaseKey));
});

// ── LifecyclePolicy: normalWorkerPolicy ────────────────────────────────────────

test('normalWorkerPolicy: detached=true, 登録あり, resume対象, worktree保持, execution-registry参加', () => {
  const policy = normalWorkerPolicy();
  assert.equal(policy.detached, true);
  assert.equal(policy.registerInWorkersJson, true);
  assert.equal(policy.resumeTarget, true);
  assert.equal(policy.keepWorktree, true);
  assert.equal(policy.onSuccess, null);
  assert.equal(policy.onFailure, null);
  assert.equal(policy.participateInExecutionRegistry, true);
});

test('normalWorkerPolicy: 返り値はfreezeされている', () => {
  const policy = normalWorkerPolicy();
  assert.throws(() => { policy.detached = false; }, /frozen|read.only/i);
});

// ── LifecyclePolicy: reviewManagerPolicy ───────────────────────────────────────

test('reviewManagerPolicy: detached=false（完了待ち）, 非登録, resume非対象, worktree破棄, execution-registry非参加', () => {
  const policy = reviewManagerPolicy();
  assert.equal(policy.detached, false);
  assert.equal(policy.registerInWorkersJson, false);
  assert.equal(policy.resumeTarget, false);
  assert.equal(policy.keepWorktree, false);
  assert.equal(policy.onSuccess, null);
  assert.equal(policy.onFailure, null);
  assert.equal(policy.participateInExecutionRegistry, false);
});

test('reviewManagerPolicy: 返り値はfreezeされている', () => {
  const policy = reviewManagerPolicy();
  assert.throws(() => { policy.keepWorktree = true; }, /frozen|read.only/i);
});

// ── 2つのポリシーの差異検証 ────────────────────────────────────────────────────

test('ポリシー差異: 通常ワーカーとReview Managerは全フィールドが異なる', () => {
  const normal = normalWorkerPolicy();
  const rm = reviewManagerPolicy();

  // 全真偽値フィールドが反転している
  assert.notEqual(normal.detached, rm.detached);
  assert.notEqual(normal.registerInWorkersJson, rm.registerInWorkersJson);
  assert.notEqual(normal.resumeTarget, rm.resumeTarget);
  assert.notEqual(normal.keepWorktree, rm.keepWorktree);
  assert.notEqual(normal.participateInExecutionRegistry, rm.participateInExecutionRegistry);
});

// ── WorkerLaunchSpec の不変性 ──────────────────────────────────────────────────

test('buildNormalWorkerLaunchSpec: 返り値はfreezeされている', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: '/ws',
  });
  assert.throws(() => { spec.workerName = 'hacked'; }, /frozen|read.only/i);
});

test('buildReviewManagerLaunchSpec: 返り値はfreezeされている', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: '/ws',
  });
  assert.throws(() => { spec.leaseKey = 'hacked'; }, /frozen|read.only/i);
});

// ── 通常ワーカー vs Review Manager の LaunchSpec 差異検証 ──────────────────────

test('LaunchSpec差異: 通常ワーカーはpr=null、Review Managerはprが設定される', () => {
  const normal = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: '/ws',
  });
  const rm = buildReviewManagerLaunchSpec({
    issue: 5, pr: '42', repo: 'o/r', workspace: '/ws',
  });

  assert.equal(normal.pr, null);
  assert.notEqual(rm.pr, null);
});

test('LaunchSpec差異: 通常ワーカーはworktreeKey=workerName、Review Managerは異なる', () => {
  const normal = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: '/ws',
  });
  const rm = buildReviewManagerLaunchSpec({
    issue: 5, pr: '42', repo: 'o/r', workspace: '/ws',
  });

  assert.equal(normal.worktreeKey, normal.workerName);
  assert.notEqual(rm.worktreeKey, rm.workerName);
});

test('LaunchSpec差異: 通常ワーカーはleaseStoreがworkers.json、Review Managerは.runningファイル', () => {
  const normal = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });
  const rm = buildReviewManagerLaunchSpec({
    issue: 5, pr: '42', repo: 'o/r', workspace: 'C:/ws',
  });

  assert.match(normal.leaseStore, /workers\.json$/);
  assert.match(rm.leaseStore, /review-manager-42\.running$/);
});
