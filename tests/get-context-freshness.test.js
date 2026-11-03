'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateInstallSource,
  readInstalledSource,
  compareRemoteCommits,
  getFreshnessStatus,
  formatFreshnessStatus,
} = require('../scripts/get-context');

const LOCAL_HEAD = 'a'.repeat(40);
const INSTALLED_HEAD = 'b'.repeat(40);
const INSTALL_SOURCE = {
  repo: 'jintrick/gh-maestro',
  branch: 'dev',
  commit: INSTALLED_HEAD,
};

function compareFixture(aheadBy) {
  const calls = [];
  return {
    calls,
    spawnSyncFn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ ahead_by: aheadBy.shift() }), stderr: '' };
    },
  };
}

test('local branch遅延件数と別repoにあるinstall元の遅延をそれぞれ出力する', () => {
  const fixture = compareFixture([3, 2]);
  const result = getFreshnessStatus({
    workspace: 'C:/isolated/workspace',
    repo: 'acme/project',
    branch: 'release/2026',
    installedSource: INSTALL_SOURCE,
    resolveHeadFn: () => LOCAL_HEAD,
    spawnSyncFn: fixture.spawnSyncFn,
  });

  assert.deepEqual(result, {
    baseStatus: { status: 'behind', behindCommits: 3 },
    installStatus: { status: 'stale', behindCommits: 2, installedCommit: INSTALLED_HEAD },
  });
  assert.deepEqual(fixture.calls.map(call => call.args), [
    ['api', `repos/acme/project/compare/${LOCAL_HEAD}...release%2F2026`],
    ['api', `repos/jintrick/gh-maestro/compare/${INSTALLED_HEAD}...dev`],
  ]);
  assert.ok(fixture.calls.every(call => call.options.cwd === 'C:/isolated/workspace'));
  assert.ok(fixture.calls.every(call => call.options.timeout === 15000));
  assert.deepEqual(formatFreshnessStatus(result), [
    'BASE_BRANCH_STATUS=behind BEHIND_COMMITS=3',
    `GH_MAESTRO_INSTALL_STATUS=stale BEHIND_COMMITS=2 INSTALLED_COMMIT=${INSTALLED_HEAD}`,
  ]);
});

test('両方が最新なら起動報告に鮮度行を追加しない', () => {
  const fixture = compareFixture([0, 0]);
  const result = getFreshnessStatus({
    workspace: 'isolated',
    repo: 'acme/project',
    branch: 'dev',
    installedSource: INSTALL_SOURCE,
    resolveHeadFn: () => LOCAL_HEAD,
    spawnSyncFn: fixture.spawnSyncFn,
  });

  assert.deepEqual(result, {
    baseStatus: { status: 'up-to-date' },
    installStatus: { status: 'up-to-date' },
  });
  assert.deepEqual(formatFreshnessStatus(result), []);
});

test('同じrepo・branch・commitの比較は一度だけ実行する', () => {
  const fixture = compareFixture([0]);
  const result = getFreshnessStatus({
    workspace: 'isolated',
    repo: 'jintrick/gh-maestro',
    branch: 'dev',
    installedSource: { ...INSTALL_SOURCE, commit: LOCAL_HEAD },
    resolveHeadFn: () => LOCAL_HEAD,
    spawnSyncFn: fixture.spawnSyncFn,
  });

  assert.deepEqual(result, {
    baseStatus: { status: 'up-to-date' },
    installStatus: { status: 'up-to-date' },
  });
  assert.equal(fixture.calls.length, 1);
});

test('GitHub照会失敗は理由付きunknownになり、もう片方の照会も実行する', () => {
  const calls = [];
  const result = getFreshnessStatus({
    workspace: 'isolated',
    repo: 'acme/project',
    branch: 'dev',
    installedSource: INSTALL_SOURCE,
    resolveHeadFn: () => LOCAL_HEAD,
    spawnSyncFn(command, args) {
      calls.push(args);
      return { status: 1, stdout: '', stderr: 'network unavailable' };
    },
  });

  assert.equal(calls.length, 2);
  assert.match(result.baseStatus.reason, /network unavailable/);
  assert.match(result.installStatus.reason, /network unavailable/);
  assert.match(formatFreshnessStatus(result)[0], /^BASE_BRANCH_STATUS=unknown REASON=/);
  assert.match(formatFreshnessStatus(result)[1], /^GH_MAESTRO_INSTALL_STATUS=unknown REASON=/);
});

test('compare APIのJSON破損とahead_by型不正を正常値へ縮退させない', () => {
  for (const stdout of ['{ broken', JSON.stringify({ ahead_by: '0' }), 'null']) {
    assert.throws(() => compareRemoteCommits({
      repo: 'acme/project',
      base: LOCAL_HEAD,
      head: 'dev',
      cwd: 'isolated',
      spawnSyncFn: () => ({ status: 0, stdout, stderr: '' }),
    }), /JSONが不正|ahead_byが欠落または不正/);
  }
});

test('配布済みスクリプトの情報は検証し、不在・破損した情報を受け入れない', () => {
  assert.deepEqual(validateInstallSource(INSTALL_SOURCE), INSTALL_SOURCE);
  assert.throws(() => validateInstallSource({ ...INSTALL_SOURCE, commit: 'bad' }), /commit.*不正/);
  const installedSourceB64 = Buffer.from(JSON.stringify(INSTALL_SOURCE), 'utf8').toString('base64');
  assert.deepEqual(readInstalledSource({
    installedScriptPath: 'isolated/get-context.js',
    readFileFn: () => `const INSTALL_SOURCE_B64 = '${installedSourceB64}';\n`,
  }), INSTALL_SOURCE);
  assert.throws(() => readInstalledSource({
    installedScriptPath: 'isolated/get-context.js',
    readFileFn: () => "const INSTALL_SOURCE_B64 = '__GH_MAESTRO_INSTALL_SOURCE_UNSET__';\n",
  }), /情報がありません/);
});

test('ローカルHEADを確認できなくてもinstall元を独立確認し、理由を出す', () => {
  const fixture = compareFixture([0]);
  const result = getFreshnessStatus({
    workspace: 'isolated',
    repo: 'acme/project',
    branch: 'dev',
    installedSource: INSTALL_SOURCE,
    resolveHeadFn: () => { throw new Error('git unavailable'); },
    spawnSyncFn: fixture.spawnSyncFn,
  });

  assert.match(result.baseStatus.reason, /git unavailable/);
  assert.deepEqual(result.installStatus, { status: 'up-to-date' });
  assert.equal(fixture.calls.length, 1);
});
