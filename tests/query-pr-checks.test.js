'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  parseCheckRuns,
  parseCommitStatuses,
  queryPrChecks,
} = require('../scripts/shared/pr-checks');
const { main, normalizePrNumber } = require('../scripts/query-pr-checks');

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function successfulDeps({ headReads, checkRuns, statuses }) {
  const calls = [];
  let readIndex = 0;
  return {
    calls,
    readPrHeadFn: () => {
      const value = headReads && headReads[readIndex] !== undefined ? headReads[readIndex] : HEAD_A;
      readIndex += 1;
      return typeof value === 'string' ? { ok: true, headSha: value } : value;
    },
    ghApiFn: endpoint => {
      calls.push(endpoint);
      if (endpoint.includes('/check-runs?')) return checkRuns;
      if (endpoint.includes('/statuses?')) return statuses;
      assert.fail(`unexpected API endpoint: ${endpoint}`);
    },
  };
}

function checkRunsResponse(checkRuns) {
  return { status: 0, stdout: JSON.stringify([{ total_count: checkRuns.length, check_runs: checkRuns }]) };
}

function statusesResponse(statuses) {
  return { status: 0, stdout: JSON.stringify([statuses]) };
}

test('parseCheckRuns は状態を4分類し、同一checkの最新attemptと詳細URLを返す', () => {
  const parsed = parseCheckRuns(JSON.stringify([{
    check_runs: [
      { name: 'build', status: 'completed', conclusion: 'failure', head_sha: HEAD_A, check_suite: { id: 10 }, run_attempt: 1, started_at: '2026-01-01T00:00:00Z', details_url: 'https://ci.invalid/build/old' },
      { name: 'build', status: 'completed', conclusion: 'success', head_sha: HEAD_A, check_suite: { id: 10 }, run_attempt: 2, started_at: '2026-01-02T00:00:00Z', details_url: 'https://ci.invalid/build/new' },
      { name: 'lint', status: 'in_progress', conclusion: null, head_sha: HEAD_A, html_url: 'https://github.com/owner/project/runs/3' },
      { name: 'package', status: 'completed', conclusion: 'neutral', head_sha: HEAD_A },
      { name: 'test', status: 'completed', conclusion: 'timed_out', head_sha: HEAD_A },
    ],
  }]), HEAD_A, 'owner/project');

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.checks, [
    { kind: 'check_run', name: 'build', state: 'success', detailsUrl: 'https://ci.invalid/build/new' },
    { kind: 'check_run', name: 'lint', state: 'running', detailsUrl: 'https://github.com/owner/project/runs/3' },
    { kind: 'check_run', name: 'package', state: 'other', detailsUrl: `https://github.com/owner/project/commit/${HEAD_A}/checks` },
    { kind: 'check_run', name: 'test', state: 'failure', detailsUrl: `https://github.com/owner/project/commit/${HEAD_A}/checks` },
  ]);
});

test('parseCheckRuns は別check suiteの同名checkを両方返す', () => {
  const parsed = parseCheckRuns(JSON.stringify([{
    check_runs: [
      { id: 1, name: 'build', status: 'completed', conclusion: 'failure', head_sha: HEAD_A, check_suite: { id: 10 } },
      { id: 2, name: 'build', status: 'completed', conclusion: 'success', head_sha: HEAD_A, check_suite: { id: 11 } },
    ],
  }]), HEAD_A, 'owner/project');

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.checks.map(({ name, state }) => ({ name, state })), [
    { name: 'build', state: 'failure' },
    { name: 'build', state: 'success' },
  ]);
});

test('parseCommitStatuses はcontextごとの最新状態だけを返す', () => {
  const parsed = parseCommitStatuses(JSON.stringify([[
    { context: 'deploy', state: 'success', sha: HEAD_A, created_at: '2026-01-02T00:00:00Z', target_url: 'https://ci.invalid/new' },
    { context: 'deploy', state: 'failure', sha: HEAD_A, created_at: '2026-01-01T00:00:00Z', target_url: 'https://ci.invalid/old' },
    { context: 'legacy', state: 'pending', sha: HEAD_A },
    { context: 'external', state: 'error', sha: HEAD_A, target_url: 'https://ci.invalid/error' },
  ]]), HEAD_A, 'owner/project');

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.checks, [
    { kind: 'commit_status', name: 'deploy', state: 'success', detailsUrl: 'https://ci.invalid/new' },
    { kind: 'commit_status', name: 'legacy', state: 'running', detailsUrl: `https://github.com/owner/project/commit/${HEAD_A}/checks` },
    { kind: 'commit_status', name: 'external', state: 'failure', detailsUrl: 'https://ci.invalid/error' },
  ]);
});

test('queryPrChecks はHEADに紐づく両種のチェックを返す', () => {
  const deps = successfulDeps({
    checkRuns: checkRunsResponse([
      { name: 'unit', status: 'completed', conclusion: 'failure', head_sha: HEAD_A, details_url: 'https://ci.invalid/unit' },
    ]),
    statuses: statusesResponse([
      { context: 'deploy', state: 'success', sha: HEAD_A, target_url: 'https://ci.invalid/deploy' },
    ]),
  });
  const result = queryPrChecks({ pr: 17, repo: 'owner/project' }, deps);

  assert.deepEqual(result, {
    ok: true,
    pr: '17',
    headSha: HEAD_A,
    checks: [
      { kind: 'check_run', name: 'unit', state: 'failure', detailsUrl: 'https://ci.invalid/unit' },
      { kind: 'commit_status', name: 'deploy', state: 'success', detailsUrl: 'https://ci.invalid/deploy' },
    ],
    hasChecks: true,
    hasRunning: false,
    allCompleted: true,
  });
  assert.deepEqual(deps.calls, [
    `repos/owner/project/commits/${HEAD_A}/check-runs?per_page=100`,
    `repos/owner/project/commits/${HEAD_A}/statuses?per_page=100`,
  ]);
});

test('queryPrChecks はチェックなしと実行中を別々に返す', () => {
  const emptyDeps = successfulDeps({
    checkRuns: checkRunsResponse([]),
    statuses: statusesResponse([]),
  });
  const empty = queryPrChecks({ pr: '17', repo: 'owner/project' }, emptyDeps);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.checks, []);
  assert.equal(empty.hasChecks, false);
  assert.equal(empty.hasRunning, false);
  assert.equal(empty.allCompleted, false);

  const runningDeps = successfulDeps({
    checkRuns: checkRunsResponse([
      { name: 'integration', status: 'queued', conclusion: null, head_sha: HEAD_A },
    ]),
    statuses: statusesResponse([]),
  });
  const running = queryPrChecks({ pr: '17', repo: 'owner/project' }, runningDeps);
  assert.equal(running.ok, true);
  assert.equal(running.hasChecks, true);
  assert.equal(running.hasRunning, true);
  assert.equal(running.allCompleted, false);
});

test('queryPrChecks はHEAD取得・API取得・HEAD変化を成功や空checksにしない', () => {
  const headFailure = queryPrChecks({ pr: 17, repo: 'owner/project' }, {
    readPrHeadFn: () => ({ ok: false, error: 'permission denied' }),
    ghApiFn: () => assert.fail('HEAD取得失敗後にGitHub APIを呼んだ'),
  });
  assert.equal(headFailure.ok, false);
  assert.match(headFailure.error, /permission denied/);

  const thrownHeadFailure = queryPrChecks({ pr: 17, repo: 'owner/project' }, {
    readPrHeadFn: () => { throw new Error('gh spawn failed'); },
    ghApiFn: () => assert.fail('HEAD取得失敗後にGitHub APIを呼んだ'),
  });
  assert.equal(thrownHeadFailure.ok, false);
  assert.match(thrownHeadFailure.error, /gh spawn failed/);

  for (const failedEndpoint of ['check-runs', 'statuses']) {
    const headReads = [{ ok: true, headSha: HEAD_A }, { ok: true, headSha: HEAD_A }];
    const result = queryPrChecks({ pr: 17, repo: 'owner/project' }, {
      readPrHeadFn: () => headReads.shift(),
      ghApiFn: endpoint => {
        if (endpoint.includes(failedEndpoint)) return { status: 1, stderr: `${failedEndpoint} failed` };
        return failedEndpoint === 'statuses'
          ? checkRunsResponse([])
          : statusesResponse([]);
      },
    });
    assert.equal(result.ok, false, `${failedEndpoint} failure must fail the query`);
    assert.match(result.error, new RegExp(`${failedEndpoint} failed`));

    const thrown = queryPrChecks({ pr: 17, repo: 'owner/project' }, {
      readPrHeadFn: () => ({ ok: true, headSha: HEAD_A }),
      ghApiFn: endpoint => {
        if (endpoint.includes(failedEndpoint)) throw new Error(`${failedEndpoint} spawn failed`);
        return failedEndpoint === 'statuses'
          ? checkRunsResponse([])
          : statusesResponse([]);
      },
    });
    assert.equal(thrown.ok, false, `${failedEndpoint} throw must fail the query`);
    assert.match(thrown.error, new RegExp(`${failedEndpoint} spawn failed`));
  }

  const changedHead = queryPrChecks({ pr: 17, repo: 'owner/project' }, successfulDeps({
    headReads: [
      { ok: true, headSha: HEAD_A },
      { ok: true, headSha: HEAD_B },
    ],
    checkRuns: checkRunsResponse([]),
    statuses: statusesResponse([]),
  }));
  assert.equal(changedHead.ok, false);
  assert.match(changedHead.error, /HEADが変わりました/);
});

test('queryPrChecks はGitHub応答の型不正と異なるHEADを拒否する', () => {
  const invalidRuns = queryPrChecks({ pr: 17, repo: 'owner/project' }, successfulDeps({
    checkRuns: { status: 0, stdout: '{bad json' },
    statuses: statusesResponse([]),
  }));
  assert.equal(invalidRuns.ok, false);
  assert.match(invalidRuns.error, /JSONパース/);

  const malformedRuns = queryPrChecks({ pr: 17, repo: 'owner/project' }, successfulDeps({
    checkRuns: { status: 0, stdout: JSON.stringify([{ check_runs: {} }]) },
    statuses: statusesResponse([]),
  }));
  assert.equal(malformedRuns.ok, false);
  assert.match(malformedRuns.error, /Check Runsのページ形式が不正/);

  const malformedStatuses = queryPrChecks({ pr: 17, repo: 'owner/project' }, successfulDeps({
    checkRuns: checkRunsResponse([]),
    statuses: statusesResponse([{ context: 42, state: 'failure', sha: HEAD_A }]),
  }));
  assert.equal(malformedStatuses.ok, false);
  assert.match(malformedStatuses.error, /commit statusの形式が不正/);

  const wrongHead = queryPrChecks({ pr: 17, repo: 'owner/project' }, successfulDeps({
    checkRuns: checkRunsResponse([
      { name: 'stale', status: 'completed', conclusion: 'success', head_sha: HEAD_B },
    ]),
    statuses: statusesResponse([]),
  }));
  assert.equal(wrongHead.ok, false);
  assert.match(wrongHead.error, /HEADが対象と一致しません/);
});

test('query-pr-checks main は1行JSONと非0エラーを返す', () => {
  const result = main(['--pr', '17', '--repo', 'owner/project'], {
    resolveRepoFn: () => ({ ok: true, repo: 'owner/project' }),
    queryPrChecksFn: () => ({
      ok: true,
      pr: '17',
      headSha: HEAD_A,
      checks: [],
      hasChecks: false,
      hasRunning: false,
      allCompleted: false,
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).headSha, HEAD_A);
  assert.equal(result.stdout.includes('\n'), false);

  const failed = main(['--pr', '17', '--repo', 'owner/project'], {
    resolveRepoFn: () => ({ ok: true, repo: 'owner/project' }),
    queryPrChecksFn: () => ({ ok: false, error: 'GitHub offline' }),
  });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.stderr, /GitHub offline/);
});

test('query-pr-checks CLI exposes help and rejects missing/invalid PR at process boundary', () => {
  const script = path.join(__dirname, '..', 'scripts', 'query-pr-checks.js');
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);

  const missing = spawnSync(process.execPath, [script, '--repo', 'owner/project'], { encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--pr/);

  for (const pr of ['0', '1junk']) {
    const invalid = spawnSync(process.execPath, [script, '--pr', pr, '--repo', 'owner/project'], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /正の整数/);
  }
});

test('normalizePrNumber は正の整数文字列だけを受け付ける', () => {
  assert.equal(normalizePrNumber('17'), '17');
  assert.equal(normalizePrNumber(' 17 '), '17');
  assert.equal(normalizePrNumber('0'), null);
  assert.equal(normalizePrNumber('17x'), null);
});
