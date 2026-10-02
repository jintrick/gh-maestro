'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

const {
  formatBaseBranchStatus,
  formatInstallStatus,
  inspectFreshness,
  readInstallSource,
} = require('../scripts/shared/freshness-status');

const SHA_LOCAL = '1'.repeat(40);
const SHA_INSTALLED = '2'.repeat(40);
const SHA_REMOTE = '3'.repeat(40);

function temporaryRecord(recordText) {
  const scope = createTempDirScope();
  const dir = scope.mkdtemp('ghm-freshness-test-');
  const recordPath = path.join(dir, 'install-source.json');
  if (recordText !== undefined) fs.writeFileSync(recordPath, recordText, 'utf8');
  return { dir, recordPath, cleanup: () => scope.cleanup() };
}

function ghResponses({ behindBy = 0, branchSha = SHA_REMOTE, compareBehindBy } = {}) {
  const calls = [];
  const spawnSyncFn = (command, args) => {
    calls.push({ command, args });
    assert.equal(command, 'gh');
    if (args[args.length - 1] === '.commit.sha') {
      return { status: 0, stdout: `${branchSha}\n`, stderr: '' };
    }
    const value = typeof compareBehindBy === 'function'
      ? compareBehindBy(args[1])
      : behindBy;
    return { status: 0, stdout: `${value}\n`, stderr: '' };
  };
  return { calls, spawnSyncFn };
}

function validRecord(repository = 'owner/repo', branch = 'dev', commit = SHA_INSTALLED) {
  return JSON.stringify({
    schemaVersion: 1,
    sourceRepository: repository,
    sourceBranch: branch,
    sourceCommit: commit,
  });
}

test('inspectFreshness: ローカル基準がbehindの件数を返し、渡されたrepoをgh apiへ使う', () => {
  const fixture = temporaryRecord();
  const { dir, recordPath } = fixture;
  const { calls, spawnSyncFn } = ghResponses({ behindBy: 3 });
  try {
    const result = inspectFreshness({
      workspace: dir,
      repository: 'passed/repository',
      baseBranch: 'dev',
      localHead: SHA_LOCAL,
      recordPath,
      spawnSyncFn,
    });

    assert.deepEqual(result.baseBranch, {
      status: 'behind',
      behindCommits: 3,
      remoteCommit: SHA_REMOTE,
    });
    assert.equal(result.install.status, 'unknown');
    assert.match(result.install.reason, /ありません/);
    assert.equal(calls.length, 2, 'install-sourceが無い場合はbase判定だけを照会する');
    assert.equal(calls[0].args[1], 'repos/passed/repository/branches/dev');
    assert.deepEqual(calls[0].args.slice(-2), ['--jq', '.commit.sha']);
    assert.match(calls[1].args[1], /^repos\/passed\/repository\/compare\/[0-9a-f]+\.\.\.[0-9a-f]+$/);
  } finally {
    fixture.cleanup();
  }
});

test('inspectFreshness: up-to-dateのbaseとstaleなinstallを同一branch headのcacheで判定する', () => {
  const fixture = temporaryRecord(validRecord('owner/repo', 'dev'));
  const { dir, recordPath } = fixture;
  const { calls, spawnSyncFn } = ghResponses({
    compareBehindBy: (endpoint) => (endpoint.includes(`${SHA_INSTALLED}...`) ? 4 : 0),
  });
  try {
    const result = inspectFreshness({
      workspace: dir,
      repository: 'owner/repo',
      baseBranch: 'dev',
      localHead: SHA_LOCAL,
      recordPath,
      spawnSyncFn,
    });

    assert.deepEqual(result.baseBranch, { status: 'up-to-date', remoteCommit: SHA_REMOTE });
    assert.deepEqual(result.install, {
      status: 'stale',
      behindCommits: 4,
      sourceRepository: 'owner/repo',
      sourceBranch: 'dev',
      installedCommit: SHA_INSTALLED,
      remoteCommit: SHA_REMOTE,
    });
    assert.equal(calls.filter((call) => call.args[1].includes('/branches/')).length, 1,
      '同じrepo/branchのremote headを再利用する');
    assert.equal(calls.filter((call) => call.args[1].includes('/compare/')).length, 2);
  } finally {
    fixture.cleanup();
  }
});

test('readInstallSource: 不在・JSON構文エラー・型不正を別々の確認不能理由にする', () => {
  const absent = temporaryRecord();
  const malformed = temporaryRecord('{ broken');
  const invalid = temporaryRecord(JSON.stringify({
    schemaVersion: 1,
    sourceRepository: 'owner/repo',
    sourceBranch: 'dev',
    sourceCommit: 'not-a-sha',
  }));
  try {
    const absentResult = readInstallSource(absent.recordPath);
    const malformedResult = readInstallSource(malformed.recordPath);
    const invalidResult = readInstallSource(invalid.recordPath);

    assert.equal(absentResult.status, 'absent');
    assert.match(absentResult.reason, /ありません/);
    assert.equal(malformedResult.status, 'unknown');
    assert.match(malformedResult.reason, /JSON構文エラー/);
    assert.equal(invalidResult.status, 'unknown');
    assert.match(invalidResult.reason, /形式が不正/);
  } finally {
    for (const entry of [absent, malformed, invalid]) entry.cleanup();
  }
});

test('inspectFreshness: gh api失敗時はbaseとinstallをunknownへ縮退させる', () => {
  const fixture = temporaryRecord(validRecord());
  const { dir, recordPath } = fixture;
  const spawnSyncFn = (command, args) => {
    assert.equal(command, 'gh');
    assert.equal(args[0], 'api');
    return { status: 1, stdout: '', stderr: 'network unavailable\n' };
  };
  try {
    const result = inspectFreshness({
      workspace: dir,
      repository: 'owner/repo',
      baseBranch: 'dev',
      localHead: SHA_LOCAL,
      recordPath,
      spawnSyncFn,
    });
    assert.equal(result.baseBranch.status, 'unknown');
    assert.match(result.baseBranch.reason, /gh api/);
    assert.equal(result.install.status, 'unknown');
    assert.match(result.install.reason, /gh api/);
  } finally {
    fixture.cleanup();
  }
});

test('format status: unknownを最新扱いせず、必要な事実を行へ出力する', () => {
  assert.equal(formatBaseBranchStatus({ status: 'behind', behindCommits: 2 }),
    'BASE_BRANCH_STATUS=behind BEHIND_COMMITS=2');
  assert.equal(formatBaseBranchStatus({ status: 'up-to-date' }), 'BASE_BRANCH_STATUS=up-to-date');
  assert.equal(formatBaseBranchStatus({ status: 'unknown', reason: 'network\nfailed' }),
    'BASE_BRANCH_STATUS=unknown REASON=network failed');
  assert.equal(formatInstallStatus({
    status: 'stale',
    sourceRepository: 'owner/repo',
    sourceBranch: 'dev',
    installedCommit: SHA_INSTALLED,
    behindCommits: 4,
  }), `GH_MAESTRO_INSTALL_STATUS=stale SOURCE_REPOSITORY=owner/repo SOURCE_BRANCH=dev INSTALLED_COMMIT=${SHA_INSTALLED} BEHIND_COMMITS=4`);
});
