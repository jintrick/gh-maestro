'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readTestResultArtifact,
  testResultPath,
} = require('../../scripts/shared/test-result');
const { workspaceRuntimeDir } = require('../../scripts/shared/storage-layout');
const { resolveGitHead } = require('../../scripts/shared/git-head');
const { buildCommentBody } = require('../../scripts/declare-test-result');

const RUN_TESTS = path.join(__dirname, '..', '..', 'scripts', 'run-tests.js');

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function cleanChildEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  // node --test propagates this guard to descendants. このテストは、実際のrunnerと
  // その宣言済みコマンドのプロセス境界を検証するため、fixture用の子だけ解除する。
  delete env.NODE_TEST_CONTEXT;
  delete env.GH_MAESTRO_WORKER;
  delete env.GH_MAESTRO_ISSUE;
  delete env.GH_MAESTRO_REPO;
  delete env.GH_MAESTRO_BASE_BRANCH;
  return env;
}

function createProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-declared-project-'));
  const marker = path.join(os.tmpdir(), `gh-maestro-declared-run-${process.pid}-${Date.now()}.log`);
  const runner = `
const fs = require('fs');
fs.appendFileSync(process.env.RUNNER_MARKER, process.env.RUNNER_MODE + '\\n', 'utf8');
process.stdout.write('custom runner output\\n');
process.exit(Number(process.env.RUNNER_EXIT || 0));
`;
  fs.mkdirSync(path.join(project, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(project, 'runner.js'), runner.trimStart(), 'utf8');
  fs.writeFileSync(path.join(project, '.gh-maestro', 'config.json'), JSON.stringify({
    test: {
      layers: {
        every: {
          scope: 'full',
          command: [process.execPath, 'runner.js'],
        },
      },
    },
  }, null, 2), 'utf8');

  runGit(project, ['init', '-q']);
  runGit(project, ['config', 'user.email', 'test@example.invalid']);
  runGit(project, ['config', 'user.name', 'gh-maestro test']);
  runGit(project, ['add', '-A']);
  runGit(project, ['commit', '-qm', 'fixture']);
  return { project, marker };
}

function runDeclaredTests(project, marker, mode, exitCode) {
  const env = cleanChildEnv({
    RUNNER_MARKER: marker,
    RUNNER_MODE: mode,
    RUNNER_EXIT: String(exitCode),
  });
  return spawnSync(process.execPath, [RUN_TESTS, '--workspace', project, 'every'], {
    cwd: project,
    env,
    encoding: 'utf8',
  });
}

function createWorkspaceAndWorktreePair() {
  const configWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-config-workspace-'));
  const executionWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-execution-worktree-'));
  const marker = path.join(os.tmpdir(), `gh-maestro-worktree-target-${process.pid}-${Date.now()}.log`);
  const runnerSource = (label) => `
const fs = require('fs');
fs.appendFileSync(process.env.RUNNER_MARKER, ${JSON.stringify(label)} + '\\n', 'utf8');
process.stdout.write('custom runner output\\n');
`.trimStart();

  fs.mkdirSync(path.join(configWorkspace, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(configWorkspace, '.gh-maestro', 'config.json'), JSON.stringify({
    test: {
      layers: {
        every: {
          scope: 'full',
          command: [process.execPath, 'runner.js'],
        },
      },
    },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(configWorkspace, 'runner.js'), runnerSource('config-workspace'), 'utf8');
  fs.writeFileSync(path.join(executionWorktree, 'runner.js'), runnerSource('execution-worktree'), 'utf8');

  for (const project of [configWorkspace, executionWorktree]) {
    runGit(project, ['init', '-q']);
    runGit(project, ['config', 'user.email', 'test@example.invalid']);
    runGit(project, ['config', 'user.name', 'gh-maestro test']);
    runGit(project, ['add', '-A']);
    runGit(project, ['commit', '-qm', 'fixture']);
  }

  return { configWorkspace, executionWorktree, marker };
}

function clearTestResult(project) {
  try { fs.rmSync(testResultPath(project), { force: true }); } catch {}
  try { fs.rmSync(workspaceRuntimeDir(project), { recursive: true, force: true }); } catch {}
}

function createMissingNodeTestProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-missing-node-test-'));
  fs.mkdirSync(path.join(project, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(path.join(project, '.gh-maestro', 'config.json'), JSON.stringify({
    test: {
      layers: {
        every: {
          scope: 'full',
          command: [process.execPath, '--test', 'tests/does-not-exist.test.js'],
        },
      },
    },
  }, null, 2), 'utf8');
  runGit(project, ['init', '-q']);
  runGit(project, ['config', 'user.email', 'test@example.invalid']);
  runGit(project, ['config', 'user.name', 'gh-maestro test']);
  runGit(project, ['add', '-A']);
  runGit(project, ['commit', '-qm', 'fixture']);
  return project;
}

test('run-tests.js: 別構成のworkspace宣言で独自コマンドを実行し、件数なしでもpass/failを申告できる', () => {
  const { project, marker } = createProject();
  const resultPath = testResultPath(project);
  const runtimeDir = workspaceRuntimeDir(project);
  try {
    const passed = runDeclaredTests(project, marker, 'pass', 0);
    assert.equal(passed.status, 0, `runner failed: ${passed.stderr}`);
    const passArtifact = readTestResultArtifact(project);
    assert.equal(passArtifact.ok, true);
    assert.equal(passArtifact.result.provenance, 'test-runner');
    // 成果物は層ごとの結果集合になった（Issue #461 / PR #462）。最上位の scope は
    // aggregate で、宣言された層の scope は layers 側に入る。
    assert.equal(passArtifact.result.scope, 'aggregate');
    assert.equal(passArtifact.result.layers.every.scope, 'full');
    assert.equal(passArtifact.result.layers.every.outcome, 'pass');
    assert.equal('tests' in passArtifact.result.layers.every, false);
    assert.match(buildCommentBody({
      commit: resolveGitHead(project),
      testResult: passArtifact.result,
    }), /結果\*\*: pass/);

    const failed = runDeclaredTests(project, marker, 'fail', 7);
    assert.equal(failed.status, 7, `runner did not preserve exit code: ${failed.stderr}`);
    const failArtifact = readTestResultArtifact(project);
    assert.equal(failArtifact.ok, true);
    assert.equal(failArtifact.result.layers.every.outcome, 'fail');
    assert.match(buildCommentBody({
      commit: resolveGitHead(project),
      testResult: failArtifact.result,
    }), /結果\*\*: fail/);

    assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/), ['pass', 'fail']);
  } finally {
    try { fs.rmSync(resultPath, { force: true }); } catch {}
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    fs.rmSync(project, { recursive: true, force: true });
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});

test('run-tests.js: 実在しないNodeテストファイルはtest-file-not-foundとしてunavailableになる', () => {
  const project = createMissingNodeTestProject();
  const resultPath = testResultPath(project);
  const runtimeDir = workspaceRuntimeDir(project);
  try {
    const result = spawnSync(process.execPath, [RUN_TESTS, '--workspace', project, 'every'], {
      cwd: project,
      env: cleanChildEnv(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `run-tests.js failed unexpectedly: ${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Could not find/);

    const artifact = readTestResultArtifact(project);
    assert.equal(artifact.ok, true);
    const layer = artifact.result.layers.every;
    assert.equal(layer.status, 'unavailable');
    assert.equal(layer.command, 'npm test');
    assert.match(layer.reason, /cause: test-file-not-found/);
    assert.doesNotMatch(layer.reason, /Could not find|does-not-exist/);
  } finally {
    try { fs.rmSync(resultPath, { force: true }); } catch {}
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('run-tests.js: 設定workspaceと実行worktreeを分離し、両方の指定形式でworktreeのHEADと成果物を使う', () => {
  const { configWorkspace, executionWorktree, marker } = createWorkspaceAndWorktreePair();
  const worktreeHead = resolveGitHead(executionWorktree);
  const configHead = resolveGitHead(configWorkspace);
  assert.notEqual(worktreeHead, configHead, '設定用と実行用のHEADを別物にするfixtureであること');

  try {
    for (const [label, args] of [
      ['--workspace指定', [RUN_TESTS, '--workspace', configWorkspace, 'every']],
      ['環境変数継承', [RUN_TESTS, 'every']],
    ]) {
      clearTestResult(configWorkspace);
      clearTestResult(executionWorktree);
      fs.rmSync(marker, { force: true });
      const result = spawnSync(process.execPath, args, {
        cwd: executionWorktree,
        env: cleanChildEnv({
          GH_MAESTRO_WORKSPACE: configWorkspace,
          RUNNER_MARKER: marker,
        }),
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, `${label}でrun-tests.jsが失敗しました: ${result.stderr}`);
      assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/), ['execution-worktree']);

      const executionArtifact = readTestResultArtifact(executionWorktree);
      assert.equal(executionArtifact.ok, true);
      assert.equal(executionArtifact.result.testedHead, worktreeHead);
      assert.equal(executionArtifact.result.layers.every.testedHead, worktreeHead);
      assert.equal(readTestResultArtifact(configWorkspace).reason, 'missing');
    }
  } finally {
    clearTestResult(configWorkspace);
    clearTestResult(executionWorktree);
    fs.rmSync(configWorkspace, { recursive: true, force: true });
    fs.rmSync(executionWorktree, { recursive: true, force: true });
    fs.rmSync(marker, { force: true });
  }
});
