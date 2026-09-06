'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readTestResultArtifact } = require('../../scripts/shared/test-result');
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

test('run-tests.js: 別構成のworkspace宣言で独自コマンドを実行し、件数なしでもpass/failを申告できる', () => {
  const { project, marker } = createProject();
  try {
    const passed = runDeclaredTests(project, marker, 'pass', 0);
    assert.equal(passed.status, 0, `runner failed: ${passed.stderr}`);
    const passArtifact = readTestResultArtifact(project);
    assert.equal(passArtifact.ok, true);
    assert.equal(passArtifact.result.provenance, 'test-runner');
    assert.equal(passArtifact.result.scope, 'full');
    assert.equal(passArtifact.result.outcome, 'pass');
    assert.equal('tests' in passArtifact.result, false);
    assert.match(buildCommentBody({
      commit: resolveGitHead(project),
      testResult: passArtifact.result,
    }), /結果\*\*: pass/);

    const failed = runDeclaredTests(project, marker, 'fail', 7);
    assert.equal(failed.status, 7, `runner did not preserve exit code: ${failed.stderr}`);
    const failArtifact = readTestResultArtifact(project);
    assert.equal(failArtifact.ok, true);
    assert.equal(failArtifact.result.outcome, 'fail');
    assert.match(buildCommentBody({
      commit: resolveGitHead(project),
      testResult: failArtifact.result,
    }), /結果\*\*: fail/);

    assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/), ['pass', 'fail']);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    try { fs.rmSync(marker, { force: true }); } catch {}
  }
});
