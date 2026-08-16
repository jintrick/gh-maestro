'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  ROLE_LABEL_MAP,
  deriveRoleFromSkill,
  buildWorkerName,
  buildNormalWorkerLaunchSpec,
  buildReviewManagerLaunchSpec,
  normalWorkerPolicy,
  reviewManagerPolicy,
  assertValidIssue,
  assertValidDescription,
  assertWithinRoot,
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
    'gh-maestro-diagnostician',
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

test('ROLE_LABEL_MAP: gh-maestro-diagnostician → diagnostician', () => {
  assert.equal(ROLE_LABEL_MAP['gh-maestro-diagnostician'], 'diagnostician');
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
    buildWorkerName(7, 'diagnostician', 'crash_on_startup_v2'),
    'issue-7-diagnostician-crash_on_startup_v2',
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
    skill: 'gh-maestro-diagnostician',
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
  assert.match(spec.logPath, /records[/\\]issue[/\\]5[/\\]workers[/\\]issue-5-coder-fix-auth[/\\]worker\.log$/);
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
    'gh-maestro-diagnostician',
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

test('buildNormalWorkerLaunchSpec: 不正なカスタムスキル名（危険文字を含む）はエラー', () => {
  // deriveRoleFromSkill は DESCRIPTION_RE 検証を通らない role を拒否する
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'unsafe/skill/../name',
      issue: 1,
      description: 'test',
      repo: 'o/r',
      workspace: '/ws',
    }),
    /安全な識別子/,
  );
});

// ── deriveRoleFromSkill ─────────────────────────────────────────────────────

test('deriveRoleFromSkill: ROLE_LABEL_MAP に登録済みのスキルはその role を返す', () => {
  assert.equal(deriveRoleFromSkill('gh-maestro-coder'), 'coder');
  assert.equal(deriveRoleFromSkill('gh-maestro-senior-coder'), 'senior-coder');
  assert.equal(deriveRoleFromSkill('gh-maestro-reviewer'), 'review-manager');
});

test('deriveRoleFromSkill: 未登録の gh-maestro-* スキルはプレフィックスを除去して導出する', () => {
  assert.equal(deriveRoleFromSkill('gh-maestro-custom-reviewer'), 'custom-reviewer');
  assert.equal(deriveRoleFromSkill('gh-maestro-my-special-coder'), 'my-special-coder');
});

test('deriveRoleFromSkill: gh-maestro- プレフィックスが無いスキルはそのまま role として使う', () => {
  assert.equal(deriveRoleFromSkill('simple-worker'), 'simple-worker');
  assert.equal(deriveRoleFromSkill('my-custom-skill'), 'my-custom-skill');
});

test('deriveRoleFromSkill: 危険文字（スラッシュ等）を含む導出 role はエラー', () => {
  assert.throws(
    () => deriveRoleFromSkill('gh-maestro-role/with/slash'),
    /安全な識別子/,
  );
  assert.throws(
    () => deriveRoleFromSkill('../escape'),
    /安全な識別子/,
  );
});

// ── カスタムスキルの LaunchSpec 生成 ─────────────────────────────────────────

test('buildNormalWorkerLaunchSpec: カスタムスキル（gh-maestro-custom-reviewer）で起動仕様を生成できる', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-custom-reviewer',
    issue: 10,
    description: 'audit-logs',
    repo: 'o/r',
    workspace: '/ws',
  });
  assert.equal(spec.workerName, 'issue-10-custom-reviewer-audit-logs');
  assert.equal(spec.role, 'custom-reviewer');
  assert.equal(spec.skill, 'gh-maestro-custom-reviewer');
  assert.equal(spec.worktreeKey, spec.workerName);
});

test('buildNormalWorkerLaunchSpec: gh-maestro-reviewer は通常ワーカーとして受け付ける（手動デバッグ経路）', () => {
  // docs/review-manager-plan.md に記載の手動デバッグ経路:
  //   spawn-worker.js --skill gh-maestro-reviewer
  // 通常ワーカーと同じ規約（worktreeKey=workerName, lease=workers.json）で起動する。
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-reviewer',
    issue: 55,
    description: 'debug-pr-7',
    repo: 'o/r',
    workspace: '/ws',
  });
  assert.equal(spec.workerName, 'issue-55-review-manager-debug-pr-7');
  assert.equal(spec.role, 'review-manager');
  assert.equal(spec.skill, 'gh-maestro-reviewer');
  assert.equal(spec.pr, null);
  assert.equal(spec.worktreeKey, spec.workerName);
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
  assert.match(spec.leaseStore, /records[\\/]pr[\\/]42[\\/]review[\\/]manager\.running$/);
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
  assert.match(logPath, /records[/\\]issue[/\\]5[/\\]workers[/\\]issue-5-coder-fix-auth[/\\]worker\.log$/);
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
  assert.equal(findingsPath, path.join(ghDir, 'records', 'pr', '42', 'review', 'manager.json'));
  assert.match(findingsPath, /records[\\/]pr[\\/]42[\\/]review[\\/]manager\.json$/);
});

// ── LifecyclePolicy: normalWorkerPolicy ────────────────────────────────────────

test('normalWorkerPolicy: completionMode=launch-accepted, 登録あり, resume対象, worktree保持, execution-registry参加', () => {
  const policy = normalWorkerPolicy();
  assert.equal(policy.completionMode, 'launch-accepted');
  assert.equal(policy.registerInWorkersJson, true);
  assert.equal(policy.resumeTarget, true);
  assert.equal(policy.keepWorktree, true);
  assert.equal(policy.timeoutMs, null);
  assert.equal(policy.artifactConfig, null);
  assert.equal(policy.onSuccess, null);
  assert.equal(policy.onFailure, null);
  assert.equal(policy.participateInExecutionRegistry, true);
});

test('normalWorkerPolicy: 返り値はfreezeされている', () => {
  const policy = normalWorkerPolicy();
  assert.throws(() => { policy.completionMode = 'process-exit'; }, /frozen|read.only/i);
});

// ── LifecyclePolicy: reviewManagerPolicy ───────────────────────────────────────

test('reviewManagerPolicy: completionMode=artifact-committed, 非登録, resume非対象, worktree破棄, execution-registry非参加', () => {
  const policy = reviewManagerPolicy();
  assert.equal(policy.completionMode, 'artifact-committed');
  assert.equal(policy.registerInWorkersJson, false);
  assert.equal(policy.resumeTarget, false);
  assert.equal(policy.keepWorktree, false);
  assert.equal(policy.onSuccess, null);
  assert.equal(policy.onFailure, null);
  assert.equal(policy.participateInExecutionRegistry, false);
  assert.equal(typeof policy.timeoutMs, 'number');
  assert.ok(policy.timeoutMs > 0, 'timeoutMs は正の値');
  assert.notEqual(policy.artifactConfig, null);
  assert.equal(typeof policy.artifactConfig.outputFileName, 'string');
  assert.equal(typeof policy.artifactConfig.pollIntervalMs, 'number');
  assert.ok(policy.artifactConfig.pollIntervalMs > 0, 'pollIntervalMs は正の値');
});

test('reviewManagerPolicy: artifactConfig のデフォルト値', () => {
  const policy = reviewManagerPolicy();
  assert.equal(policy.artifactConfig.outputFileName, 'findings.json');
  assert.equal(policy.artifactConfig.pollIntervalMs, 200);
  assert.equal(policy.artifactConfig.schemaPath, null);
});

test('reviewManagerPolicy: opts で上書きできる', () => {
  const policy = reviewManagerPolicy({
    outputFileName: 'custom.json',
    pollIntervalMs: 500,
    schemaPath: '/path/to/schema.json',
    timeoutMs: 60000,
  });
  assert.equal(policy.artifactConfig.outputFileName, 'custom.json');
  assert.equal(policy.artifactConfig.pollIntervalMs, 500);
  assert.equal(policy.artifactConfig.schemaPath, '/path/to/schema.json');
  assert.equal(policy.timeoutMs, 60000);
});

test('reviewManagerPolicy: 返り値はfreezeされている', () => {
  const policy = reviewManagerPolicy();
  assert.throws(() => { policy.keepWorktree = true; }, /frozen|read.only/i);
});

test('reviewManagerPolicy: artifactConfig もfreezeされている', () => {
  const policy = reviewManagerPolicy();
  assert.throws(() => { policy.artifactConfig.pollIntervalMs = 999; }, /frozen|read.only/i);
});

// ── 2つのポリシーの差異検証 ────────────────────────────────────────────────────

test('ポリシー差異: 通常ワーカーとReview Managerは全フィールドが異なる', () => {
  const normal = normalWorkerPolicy();
  const rm = reviewManagerPolicy();

  // completionMode が異なる
  assert.notEqual(normal.completionMode, rm.completionMode);
  assert.equal(normal.completionMode, 'launch-accepted');
  assert.equal(rm.completionMode, 'artifact-committed');
  // その他の真偽値フィールドが反転している
  assert.notEqual(normal.registerInWorkersJson, rm.registerInWorkersJson);
  assert.notEqual(normal.resumeTarget, rm.resumeTarget);
  assert.notEqual(normal.keepWorktree, rm.keepWorktree);
  assert.notEqual(normal.participateInExecutionRegistry, rm.participateInExecutionRegistry);
  // artifactConfig は通常ワーカーでは null、Review Managerでは設定あり
  assert.equal(normal.artifactConfig, null);
  assert.notEqual(rm.artifactConfig, null);
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
  assert.match(rm.leaseStore, /records[/\\]pr[/\\]42[/\\]review[/\\]manager\.running$/);
});

// ── 入力バリデーション: assertValidIssue ───────────────────────────────────────

test('assertValidIssue: 正整数文字列を受け付ける', () => {
  assert.equal(assertValidIssue('1'), 1);
  assert.equal(assertValidIssue('42'), 42);
  assert.equal(assertValidIssue('99999'), 99999);
});

test('assertValidIssue: 数値も受け付ける', () => {
  assert.equal(assertValidIssue(1), 1);
  assert.equal(assertValidIssue(42), 42);
});

test('assertValidIssue: 0 は拒否する', () => {
  assert.throws(() => assertValidIssue('0'), /invalid issue number/);
  assert.throws(() => assertValidIssue(0), /invalid issue number/);
});

test('assertValidIssue: 負数は拒否する', () => {
  assert.throws(() => assertValidIssue('-1'), /invalid issue number/);
  assert.throws(() => assertValidIssue(-5), /invalid issue number/);
});

test('assertValidIssue: 非数値は拒否する', () => {
  assert.throws(() => assertValidIssue('abc'), /invalid issue number/);
  assert.throws(() => assertValidIssue(''), /invalid issue number/);
  assert.throws(() => assertValidIssue('1.5'), /invalid issue number/);
});

test('assertValidIssue: 先頭ゼロは拒否する（01 は git branch の挙動を変えうる危険な値）', () => {
  // spawn-worker.js の ISSUE_RE /^[1-9][0-9]*$/ は 01 等の先頭ゼロを拒否する。
  // 先頭ゼロは Number('01') => 1 と正規化され番号としては有効に見えるが、
  // 後続の文字列連結（issue-01-...）でgit branch名に混入しうるため、
  // 曖昧な解釈を許す前に文字列レベルで弾く。
  assert.throws(() => assertValidIssue('01'), /invalid issue number/);
  assert.throws(() => assertValidIssue('001'), /invalid issue number/);
});

// ── 入力バリデーション: assertValidDescription ────────────────────────────────

test('assertValidDescription: 英数字・ハイフン・アンダースコア 1〜50文字を受け付ける', () => {
  assert.equal(assertValidDescription('fix-auth'), 'fix-auth');
  assert.equal(assertValidDescription('explore_deps_v2'), 'explore_deps_v2');
  assert.equal(assertValidDescription('a'), 'a'); // 1文字
  assert.equal(assertValidDescription('A'.repeat(50)), 'A'.repeat(50)); // 50文字（上限）
});

test('assertValidDescription: 51文字以上は拒否する', () => {
  assert.throws(
    () => assertValidDescription('a'.repeat(51)),
    /invalid description/,
  );
});

test('assertValidDescription: 空文字列は拒否する', () => {
  assert.throws(() => assertValidDescription(''), /invalid description/);
});

test('assertValidDescription: スラッシュを含むと拒否する（パストラバーサル対策）', () => {
  assert.throws(() => assertValidDescription('foo/bar'), /invalid description/);
  assert.throws(() => assertValidDescription('a/b'), /invalid description/);
});

test('assertValidDescription: ../ を含むパストラバーサル文字列は拒否する', () => {
  assert.throws(() => assertValidDescription('../../../etc'), /invalid description/);
  assert.throws(() => assertValidDescription('x/../../../../outside'), /invalid description/);
  assert.throws(() => assertValidDescription('..'), /invalid description/);
  // ドット単体も拒否（正規表現がドットを許可していないため）
  assert.throws(() => assertValidDescription('.'), /invalid description/);
});

test('assertValidDescription: バックスラッシュを含むと拒否する', () => {
  assert.throws(() => assertValidDescription('foo\\bar'), /invalid description/);
});

test('assertValidDescription: スペースを含むと拒否する', () => {
  assert.throws(() => assertValidDescription('foo bar'), /invalid description/);
});

test('assertValidDescription: 非文字列（null/undefined/数値）は拒否する', () => {
  assert.throws(() => assertValidDescription(null), /invalid description/);
  assert.throws(() => assertValidDescription(undefined), /invalid description/);
  assert.throws(() => assertValidDescription(123), /invalid description/);
});

// ── パス封じ込め: assertWithinRoot ─────────────────────────────────────────────

test('assertWithinRoot: ルート配下のパスは通過する', () => {
  assert.doesNotThrow(() =>
    assertWithinRoot('C:\\ws\\.gh-maestro\\worktrees', 'C:\\ws\\.gh-maestro\\worktrees\\issue-5-coder-fix-auth', 'worktreeDir')
  );
});

test('assertWithinRoot: ルート自身は通過する', () => {
  assert.doesNotThrow(() =>
    assertWithinRoot('C:\\root', 'C:\\root', 'root')
  );
});

test('assertWithinRoot: ルート外のパスは拒否する', () => {
  assert.throws(
    () => assertWithinRoot('C:\\ws\\.gh-maestro\\worktrees', 'C:\\outside\\file', 'worktreeDir'),
    /管理ルート外/,
  );
});

test('assertWithinRoot: ../ による脱出を拒否する（path.resolve で正規化されて判定される）', () => {
  assert.throws(
    () => assertWithinRoot(
      'C:\\ws\\.gh-maestro\\worktrees',
      'C:\\ws\\.gh-maestro\\worktrees\\..\\..\\outside',
      'worktreeDir',
    ),
    /管理ルート外/,
  );
});

// ── factoryレベルの入力検証 ────────────────────────────────────────────────────

test('buildNormalWorkerLaunchSpec: issue が 0 だとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: 0, description: 'fix-auth', repo: 'o/r', workspace: '/ws',
    }),
    /invalid issue number/,
  );
});

test('buildNormalWorkerLaunchSpec: issue が "abc" だとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: 'abc', description: 'fix-auth', repo: 'o/r', workspace: '/ws',
    }),
    /invalid issue number/,
  );
});

test('buildNormalWorkerLaunchSpec: issue が "01"（先頭ゼロ）だとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: '01', description: 'fix-auth', repo: 'o/r', workspace: '/ws',
    }),
    /invalid issue number/,
  );
});

test('buildNormalWorkerLaunchSpec: description にパストラバーサル文字列を含むとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: 5, description: 'x/../../../../outside', repo: 'o/r', workspace: '/ws',
    }),
    /invalid description/,
  );
});

test('buildNormalWorkerLaunchSpec: description にスラッシュを含むとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: 5, description: 'foo/bar', repo: 'o/r', workspace: '/ws',
    }),
    /invalid description/,
  );
});

test('buildNormalWorkerLaunchSpec: description が 51文字以上だとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: 5, description: 'a'.repeat(51), repo: 'o/r', workspace: '/ws',
    }),
    /invalid description/,
  );
});

test('buildNormalWorkerLaunchSpec: description が空文字列だとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: 5, description: '', repo: 'o/r', workspace: '/ws',
    }),
    /invalid description/,
  );
});

test('buildNormalWorkerLaunchSpec: description にスペースを含むとエラー', () => {
  assert.throws(
    () => buildNormalWorkerLaunchSpec({
      skill: 'gh-maestro-coder', issue: 5, description: 'foo bar', repo: 'o/r', workspace: '/ws',
    }),
    /invalid description/,
  );
});

test('buildNormalWorkerLaunchSpec: 正規の入力はパスが管理ルート配下に解決される', () => {
  const spec = buildNormalWorkerLaunchSpec({
    skill: 'gh-maestro-coder',
    issue: 5,
    description: 'fix-auth',
    repo: 'o/r',
    workspace: 'C:/ws',
  });

  // worktreeDir が worktrees/ ルート配下であること
  const worktreesRoot = path.join('C:/ws', '.gh-maestro', 'worktrees');
  assert.ok(
    spec.worktreeDir.startsWith(worktreesRoot + path.sep) || spec.worktreeDir === worktreesRoot,
    `worktreeDir "${spec.worktreeDir}" should be under "${worktreesRoot}"`,
  );

  // logPath が worker-logs/ ルート配下であること
  const logsRoot = path.join('C:/ws', '.gh-maestro', 'records');
  assert.ok(
    spec.logPath.startsWith(logsRoot + path.sep) || spec.logPath === logsRoot,
    `logPath "${spec.logPath}" should be under "${logsRoot}"`,
  );
});

// ── buildReviewManagerLaunchSpec の issue 検証 ─────────────────────────────────

test('buildReviewManagerLaunchSpec: issue が 0 だとエラー', () => {
  assert.throws(
    () => buildReviewManagerLaunchSpec({ issue: 0, pr: '42', repo: 'o/r', workspace: '/ws' }),
    /invalid issue number/,
  );
});

test('buildReviewManagerLaunchSpec: issue が負数だとエラー', () => {
  assert.throws(
    () => buildReviewManagerLaunchSpec({ issue: -1, pr: '42', repo: 'o/r', workspace: '/ws' }),
    /invalid issue number/,
  );
});

test('buildReviewManagerLaunchSpec: issue が "abc" だとエラー', () => {
  assert.throws(
    () => buildReviewManagerLaunchSpec({ issue: 'abc', pr: '42', repo: 'o/r', workspace: '/ws' }),
    /invalid issue number/,
  );
});

test('buildReviewManagerLaunchSpec: 正規の入力はパスが管理ルート配下に解決される', () => {
  const spec = buildReviewManagerLaunchSpec({
    issue: 174, pr: '42', repo: 'o/r', workspace: 'C:/ws',
  });

  // worktreeDir が worktrees/ ルート配下であること
  const worktreesRoot = path.join('C:/ws', '.gh-maestro', 'worktrees');
  assert.ok(
    spec.worktreeDir.startsWith(worktreesRoot + path.sep) || spec.worktreeDir === worktreesRoot,
  );

  // logPath が worker-logs/ ルート配下であること
  const logsRoot = path.join('C:/ws', '.gh-maestro', 'records');
  assert.ok(
    spec.logPath.startsWith(logsRoot + path.sep) || spec.logPath === logsRoot,
  );
});
