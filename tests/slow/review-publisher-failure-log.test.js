'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { withTempDir } = require('../../scripts/shared/temp-directory');
const { publishReviewArtifact } = require('../../scripts/run-review-manager');
const { recordPath, ARTIFACTS } = require('../../scripts/shared/record-paths');
const { createFakeGh } = require('../helpers/fake-gh');

function writeArtifact(dir, pr = 42, repo = 'o/r', findings = []) {
  const artifactPath = path.join(dir, 'manager.json');
  fs.writeFileSync(artifactPath, JSON.stringify({
    pr,
    repo,
    headRefOid: 'abc1234',
    findings,
  }), 'utf8');
  return artifactPath;
}

function createWorkerLogger(workspace, pr, workerName) {
  const logFile = recordPath(workspace, {
    ownerKind: 'pr',
    ownerId: pr,
    artifact: ARTIFACTS.WORKER_LOG,
    workerName,
  });
  const log = (msg) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  };
  return { logFile, log };
}

function writeGhSpawnPreload(dir, stubResult) {
  const preloadPath = path.join(dir, 'gh-spawn-preload.js');
  const script = [
    "'use strict';",
    "const childProcess = require('child_process');",
    'const origSpawnSync = childProcess.spawnSync;',
    `const stub = ${JSON.stringify(stubResult)};`,
    'childProcess.spawnSync = function patchedSpawnSync(cmd, args, opts) {',
    "  if (String(cmd) === 'gh' || /(?:^|[\\\\/])gh(?:\\.exe)?$/i.test(String(cmd))) {",
    '    const result = { ...stub };',
    '    if (stub.errorMessage) {',
    '      result.error = new Error(stub.errorMessage);',
    '      if (stub.errorCode) result.error.code = stub.errorCode;',
    '    }',
    '    delete result.errorMessage;',
    '    delete result.errorCode;',
    '    return result;',
    '  }',
    '  return origSpawnSync.call(this, cmd, args, opts);',
    '};',
    '',
  ].join('\n');
  fs.writeFileSync(preloadPath, script, 'utf8');
  return preloadPath;
}

function nodeRequireFlag(filePath) {
  return `--require="${path.resolve(filePath).replace(/\\/g, '/')}"`;
}

test('slow: review-publisher 起動エラー（signal なし・途中までの stdout を伴うもの）で worker.log にエラー内容・status が残り途中 stdout で隠れない', () => {
  withTempDir('ghm-slow-rm-log-startup-', (dir) => {
    const artifactPath = writeArtifact(dir, 42, 'o/r');
    const { logFile, log } = createWorkerLogger(dir, 42, 'issue-785-review-manager-pr-42');
    const preloadPath = writeGhSpawnPreload(dir, {
      status: null,
      signal: null,
      stdout: 'diff --git a/partial-startup.js b/partial-startup.js\n+partial',
      stderr: '',
      errorMessage: 'spawnSync gh ENOBUFS',
      errorCode: 'ENOBUFS',
    });

    const publish = publishReviewArtifact({
      outputFile: artifactPath,
      workspace: dir,
      lockOwner: 'test-owner',
      log,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, nodeRequireFlag(preloadPath)].filter(Boolean).join(' '),
      },
    });

    assert.equal(publish.status, 1);
    const workerLog = fs.readFileSync(logFile, 'utf8');
    assert.match(workerLog, /spawnSync gh ENOBUFS/);
    assert.match(workerLog, /status=null/);
    assert.doesNotMatch(workerLog, /signal=/);
    assert.match(workerLog, /review-publisher exited with status 1/);
    assert.doesNotMatch(workerLog, /diff --git a\/partial-startup\.js/);
  });
});

test('slow: review-publisher が signal で終了したとき worker.log に signal と status が残り途中 stdout で隠れない', () => {
  withTempDir('ghm-slow-rm-log-signal-', (dir) => {
    const artifactPath = writeArtifact(dir, 42, 'o/r');
    const { logFile, log } = createWorkerLogger(dir, 42, 'issue-785-review-manager-pr-42');
    const preloadPath = writeGhSpawnPreload(dir, {
      status: null,
      signal: 'SIGKILL',
      stdout: 'diff --git a/partial-signal.js b/partial-signal.js\n+partial',
      stderr: '',
    });

    const publish = publishReviewArtifact({
      outputFile: artifactPath,
      workspace: dir,
      lockOwner: 'test-owner',
      log,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, nodeRequireFlag(preloadPath)].filter(Boolean).join(' '),
      },
    });

    assert.equal(publish.status, 1);
    const workerLog = fs.readFileSync(logFile, 'utf8');
    assert.match(workerLog, /signal=SIGKILL/);
    assert.match(workerLog, /status=null/);
    assert.match(workerLog, /review-publisher exited with status 1/);
    assert.doesNotMatch(workerLog, /diff --git a\/partial-signal\.js/);
  });
});

test('slow: review-publisher が非0終了したとき worker.log に status と stderr が残り途中 stdout で隠れない', () => {
  withTempDir('ghm-slow-rm-log-nonzero-', (dir) => {
    const artifactPath = writeArtifact(dir, 42, 'o/r');
    const { logFile, log } = createWorkerLogger(dir, 42, 'issue-785-review-manager-pr-42');
    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        {
          match: ['api', 'repos/o/r/pulls/42/reviews', '-X', 'POST', '-F', 'body=@-', '-f', 'event=COMMENT'],
          status: 2,
          stdout: 'partial-nonzero-stdout\n',
          stderr: 'gh: PR review post failed (HTTP 502)\n',
        },
      ],
    });

    const publish = publishReviewArtifact({
      outputFile: artifactPath,
      workspace: dir,
      lockOwner: 'test-owner',
      log,
      env: fakeGh.env,
    });

    assert.equal(publish.status, 1);
    const workerLog = fs.readFileSync(logFile, 'utf8');
    assert.match(workerLog, /status=2/);
    assert.match(workerLog, /stderr=gh: PR review post failed \(HTTP 502\)/);
    assert.match(workerLog, /review-publisher exited with status 1/);
    assert.doesNotMatch(workerLog, /partial-nonzero-stdout/);
  });
});

test('slow: pulls/{n}/files の取得失敗時はファイル単位投稿や最終レビューへ進まず失敗理由が worker.log に残る', () => {
  withTempDir('ghm-slow-rm-files-fail-', (dir) => {
    const artifactPath = writeArtifact(dir, 42, 'o/r', [
      {
        aspect: 'Correctness',
        path: 'src/foo.ts',
        line_anchor: 'save()',
        summary: 'Save is not awaited',
        severity: 'BLOCKER',
        severity_rationale: 'data loss',
        body: 'await save()',
        verified_references: ['src/foo.ts'],
      },
    ]);
    const { logFile, log } = createWorkerLogger(dir, 42, 'issue-789-review-manager-pr-42');
    const fakeGh = createFakeGh({
      binDir: path.join(dir, 'bin'),
      fixtures: [
        {
          match: { prefix: ['api', '--method', 'GET', 'repos/o/r/pulls/42/files'] },
          status: 2,
          stdout: 'partial-files-stdout\n',
          stderr: 'gh: pulls/files failed (HTTP 502)\n',
        },
      ],
    });

    const publish = publishReviewArtifact({
      outputFile: artifactPath,
      workspace: dir,
      lockOwner: 'test-owner',
      log,
      env: fakeGh.env,
    });

    assert.equal(publish.status, 1);
    const workerLog = fs.readFileSync(logFile, 'utf8');
    assert.match(workerLog, /status=2/);
    assert.match(workerLog, /stderr=gh: pulls\/files failed \(HTTP 502\)/);
    assert.match(workerLog, /review-publisher exited with status 1/);
    assert.doesNotMatch(workerLog, /partial-files-stdout/);

    const calls = fs.readFileSync(fakeGh.logPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 4), ['api', '--method', 'GET', 'repos/o/r/pulls/42/files']);
  });
});
