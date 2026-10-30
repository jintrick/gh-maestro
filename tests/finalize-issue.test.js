'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync: spawnNodeSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectWorkersForIssue,
  finalizeIssue: finalizeIssueCore,
  cleanupIssueArtifacts,
  bodyReferencesIssue,
  decisionCommentMarker,
  defaultListIssueCommentBodies,
  defaultFindDecisionPosted,
} = require('../scripts/finalize-issue.js');
const childProcess = require('../scripts/shared/child-process');

// 既存のcleanupテストでは決定コメント投稿を成功として注入する。必須入力と投稿失敗の
// 挙動はfinalizeIssueCoreを直接使う専用テストで検証する。
function finalizeIssue(params, deps = {}) {
  return finalizeIssueCore(
    { decisionBody: 'テスト決定事項', ...params },
    {
      findDecisionPostedFn: () => ({ posted: false }),
      postDecisionFn: () => ({ ok: true, url: 'https://example.test/comment/1' }),
      ...deps,
    },
  );
}

function withTempWorkspace(workers, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    if (workers !== null) {
      fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify(workers, null, 2));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeGhEnvironment(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const binDir = path.join(directory, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bootstrap = path.join(binDir, 'fake-gh-bootstrap.js');
  const commentsFile = path.join(directory, 'comments.json');
  fs.writeFileSync(bootstrap, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "if (path.basename(process.execPath).toLowerCase() === (process.platform === 'win32' ? 'gh.exe' : 'gh')) {",
    `  const commentsFile = ${JSON.stringify(commentsFile)};`,
    "  const args = [path.basename(process.argv[1]), ...process.argv.slice(2)];",
    "  process.stderr.write('fake-gh-args:' + JSON.stringify({ exe: process.execPath, argv: process.argv, args }) + '\\n');",
    "  let comments = [];",
    "  try { comments = JSON.parse(fs.readFileSync(commentsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
    "  if (args[0] === 'api') {",
    "    process.stdout.write(comments.map((comment) => Buffer.from(comment, 'utf8').toString('base64')).join('\\n'));",
    "  } else if (args[0] === 'issue' && args[1] === 'comment') {",
    "    const bodyFileIndex = args.indexOf('--body-file');",
    "    comments.push(fs.readFileSync(args[bodyFileIndex + 1], 'utf8'));",
    "    fs.writeFileSync(commentsFile, JSON.stringify(comments), 'utf8');",
    "    process.stdout.write('https://github.com/test/repo/issues/5#issuecomment-555\\n');",
    "  } else if (args[0] === 'pr' && args[1] === 'list') {",
    "    process.stdout.write('[]');",
    "  }",
    '  process.exit(0);',
    '}',
    '',
  ].join('\n'), 'utf8');
  fs.copyFileSync(process.execPath, path.join(binDir, process.platform === 'win32' ? 'gh.exe' : 'gh'));
  if (process.platform !== 'win32') fs.chmodSync(path.join(binDir, 'gh'), 0o755);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    NODE_OPTIONS: `--require="${bootstrap.replace(/\\/g, '/')}"`,
    GH_MAESTRO_FAKE_COMMENTS: commentsFile,
  };
  return { env, commentsFile };
}

test('collectWorkersForIssue: 指定Issueのワーカーだけ列挙しorchestratorは除く', () => {
  withTempWorkspace({
    orchestrator: { paneId: '0' },
    'issue-5-coder': { paneId: '1', issue: 5, skill: 'gh-maestro-coder' },
    'issue-5-explore': { paneId: '2', issue: 5, skill: 'gh-maestro-explorer' },
    'issue-9-coder': { paneId: '3', issue: 9, skill: 'gh-maestro-coder' },
  }, (dir) => {
    const names = collectWorkersForIssue(dir, 5).sort();
    assert.deepEqual(names, ['issue-5-coder', 'issue-5-explore']);
  });
});

test('collectWorkersForIssue: issueが数値でも文字列でも一致する', () => {
  withTempWorkspace({
    'issue-7-coder': { paneId: '1', issue: 7 },
  }, (dir) => {
    assert.deepEqual(collectWorkersForIssue(dir, '7'), ['issue-7-coder']);
    assert.deepEqual(collectWorkersForIssue(dir, 7), ['issue-7-coder']);
  });
});

test('collectWorkersForIssue: workers.jsonが無ければ空配列', () => {
  withTempWorkspace(null, (dir) => {
    assert.deepEqual(collectWorkersForIssue(dir, 5), []);
  });
});

test('collectWorkersForIssue: malformed JSONは対象パス付きのJSON構文エラーでthrow', () => {
  withTempWorkspace(null, (dir) => {
    const file = path.join(dir, '.gh-maestro', 'workers.json');
    fs.writeFileSync(file, '{not json', 'utf8');
    assert.throws(() => collectWorkersForIssue(dir, 5), (error) => {
      assert.match(error.message, /JSON構文エラー/);
      assert.match(error.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
  });
});

test('collectWorkersForIssue: JSONとして妥当でも配列はオブジェクトでないエラーでthrow', () => {
  withTempWorkspace([], (dir) => {
    assert.throws(() => collectWorkersForIssue(dir, 5), /JSONとしては妥当だがオブジェクトでない/);
  });
});

test('finalizeIssue: 決定事項本文が欠落または空なら後始末を開始しない', () => {
  withTempWorkspace({ 'issue-5-coder': { issue: 5 } }, (dir) => {
    let postCalls = 0;
    let closeCalls = 0;
    const deps = {
      postDecisionFn: () => { postCalls += 1; return { ok: true }; },
      closeIssueFn: () => { closeCalls += 1; return { ok: true }; },
    };
    assert.throws(() => finalizeIssueCore({ workspace: dir, issue: 5 }, deps), /決定事項本文/);
    assert.throws(() => finalizeIssueCore({ workspace: dir, issue: 5, decisionBody: '  ' }, deps), /決定事項本文/);
    assert.equal(postCalls, 0);
    assert.equal(closeCalls, 0);
  });
});

test('finalizeIssue: 決定事項コメント投稿失敗時はworker削除とIssueクローズをしない', () => {
  withTempWorkspace({ 'issue-5-coder': { issue: 5 } }, (dir) => {
    let removeCalls = 0;
    let closeCalls = 0;
    const result = finalizeIssueCore(
      { workspace: dir, issue: 5, decisionBody: '反省会なし（軽量PR）' },
      {
        findDecisionPostedFn: () => ({ posted: false }),
        postDecisionFn: () => ({ ok: false, stderr: 'GitHub unavailable' }),
        removeWorkerFn: () => { removeCalls += 1; return { ok: true }; },
        closeIssueFn: () => { closeCalls += 1; return { ok: true }; },
      },
    );
    assert.equal(result.closed, false);
    assert.equal(result.decisionPosted, false);
    assert.equal(removeCalls, 0);
    assert.equal(closeCalls, 0);
  });
});

test('finalizeIssue: 同じ決定事項を再実行しても投稿済みコメントを重複させない', () => {
  withTempWorkspace({ 'issue-5-coder': { paneId: '1', issue: 5 } }, (dir) => {
    const comments = [];
    let postCalls = 0;
    const params = { workspace: dir, issue: 5, repo: 'owner/repo', decisionBody: '採用した決定事項\n' };
    const deps = {
      findDecisionPostedFn: (input) => defaultFindDecisionPosted(input, {
        listIssueCommentBodiesFn: () => comments,
      }),
      postDecisionFn: (body) => {
        postCalls += 1;
        comments.push(body);
        return { ok: true, url: 'https://example.test/comment/1' };
      },
      clearPrMonitorTargetFn: () => true,
      closeStatusPaneFn: () => ({ ok: false, stderr: 'pane unavailable' }),
      removeWorkerFn: () => { throw new Error('failed pane must not remove worker'); },
      closeIssueFn: () => { throw new Error('failed pane must not close issue'); },
    };

    const first = finalizeIssueCore(params, deps);
    assert.equal(first.closed, false);
    assert.equal(first.decisionAlreadyPosted, false);
    assert.equal(comments.length, 1);
    assert.ok(comments[0].includes(decisionCommentMarker(5, params.decisionBody)));

    const retry = finalizeIssueCore(params, deps);
    assert.equal(retry.closed, false);
    assert.equal(retry.decisionAlreadyPosted, true);
    assert.equal(postCalls, 1, 'retry reuses the existing GitHub comment');
    assert.equal(comments.length, 1);
  });
});

test('finalizeIssue: 決定事項の既存投稿照合に失敗したら投稿も後始末もしない', () => {
  withTempWorkspace({ 'issue-5-coder': { issue: 5 } }, (dir) => {
    let postCalls = 0;
    let paneCloseCalls = 0;
    let issueCloseCalls = 0;
    const result = finalizeIssueCore(
      { workspace: dir, issue: 5, decisionBody: '照合を要する決定事項' },
      {
        findDecisionPostedFn: () => { throw new Error('GitHub API unavailable'); },
        postDecisionFn: () => { postCalls += 1; return { ok: true }; },
        clearPrMonitorTargetFn: () => { throw new Error('must not clear'); },
        closeStatusPaneFn: () => { paneCloseCalls += 1; return { ok: true }; },
        closeIssueFn: () => { issueCloseCalls += 1; return { ok: true }; },
      },
    );

    assert.equal(result.closed, false);
    assert.equal(result.decisionPosted, false);
    assert.equal(postCalls, 0);
    assert.equal(paneCloseCalls, 0);
    assert.equal(issueCloseCalls, 0);
  });
});

test('defaultListIssueCommentBodies: GitHub APIの失敗を未投稿扱いにせずエラーにする', () => {
  let captured;
  assert.throws(() => defaultListIssueCommentBodies(
    { issue: 5, repo: 'owner/repo', workspace: 'C:/temp/workspace' },
    {
      spawnSyncFn: (command, args, options) => {
        captured = { command, args, cwd: options.cwd };
        return { status: 1, stdout: '', stderr: 'rate limit' };
      },
    },
  ), /Issueコメントの照合に失敗しました: rate limit/);
  assert.deepEqual(captured, {
    command: 'gh',
    args: ['api', '--paginate', 'repos/owner/repo/issues/5/comments', '--jq', '.[].body | @base64'],
    cwd: 'C:/temp/workspace',
  });
});

test('defaultListIssueCommentBodies: ページごとにbase64化されたコメント本文を改行込みで復元する', () => {
  const bodies = ['1ページ目の本文\n2行目', '2ページ目の本文'];
  let capturedArgs;
  const decoded = defaultListIssueCommentBodies(
    { issue: 5, repo: 'owner/repo', workspace: 'C:/temp/workspace' },
    {
      spawnSyncFn: (command, args) => {
        assert.equal(command, 'gh');
        capturedArgs = args;
        return { status: 0, stdout: `${bodies.map((body) => Buffer.from(body, 'utf8').toString('base64')).join('\n')}\n`, stderr: '' };
      },
    },
  );
  assert.deepEqual(capturedArgs, ['api', '--paginate', 'repos/owner/repo/issues/5/comments', '--jq', '.[].body | @base64']);
  assert.deepEqual(decoded, bodies);
});

test('finalizeIssue: workers.jsonの読み取り失敗時はIssueをクローズしない', () => {
  withTempWorkspace(null, (dir) => {
    const file = path.join(dir, '.gh-maestro', 'workers.json');
    fs.mkdirSync(file);
    let closeCalled = false;
    assert.throws(
      () => finalizeIssue(
        { workspace: dir, issue: 5 },
        {
          closeIssueFn: () => { closeCalled = true; return { ok: true }; },
          findReviewPrsFn: () => [],
        },
      ),
      (error) => {
        assert.match(error.message, /読み取り失敗/);
        assert.match(error.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
    );
    assert.equal(closeCalled, false);
  });
});

test('finalizeIssue: 全ワーカーを削除してからIssueをクローズする（spawnはモック注入）', () => {
  withTempWorkspace({
    orchestrator: { paneId: '0' },
    'issue-5-coder': { paneId: '1', issue: 5 },
    'issue-5-explore': { paneId: '2', issue: 5 },
  }, (dir) => {
    const removed = [];
    let closedIssue = null;
    let closedStatusPane = null;
    const result = finalizeIssue(
      { workspace: dir, issue: 5, repo: 'o/r' },
      {
        removeWorkerFn: (ws, name) => { removed.push(name); return { ok: true }; },
        closeIssueFn: (issue, repo, ws) => { closedIssue = { issue, repo }; return { ok: true }; },
        closeStatusPaneFn: (ws, issue) => { closedStatusPane = { ws, issue }; return { ok: true }; },
        findReviewPrsFn: () => [],
      }
    );
    assert.deepEqual(removed.sort(), ['issue-5-coder', 'issue-5-explore']);
    assert.deepEqual(closedIssue, { issue: 5, repo: 'o/r' });
    assert.deepEqual(closedStatusPane, { ws: dir, issue: 5 });
    assert.equal(result.removedCount, 2);
    assert.equal(result.closed, true);
    assert.equal(result.statusPaneClosed, true);
  });
});

test('finalizeIssue: default close-pane のargvでworktreeを削除前に閉じ、メインworkspaceも閉じる', () => {
  withTempWorkspace({
    'issue-5-coder': { paneId: '1', issue: 5 },
    'issue-5-explore': { paneId: '2', issue: 5 },
  }, (dir) => {
    const events = [];
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      events.push(['close-pane-command', command, [...args], options.cwd]);
      return { status: 0, stdout: 'STATUS_PANE_NOT_FOUND', stderr: '' };
    };
    try {
      finalizeIssue(
        { workspace: dir, issue: 5 },
        {
          removeWorkerFn: (ws, name) => {
            events.push(['remove-worker', ws, name]);
            return { ok: true };
          },
          closeIssueFn: (issue) => {
            events.push(['close-issue', issue]);
            return { ok: true };
          },
          findReviewPrsFn: () => [],
        },
      );
    } finally {
      childProcess.spawnSync = originalSpawnSync;
    }

    const workerStatusScript = path.join(__dirname, '..', 'scripts', 'worker-status.js');
    const coderWorktree = path.resolve(dir, '.gh-maestro', 'worktrees', 'issue-5-coder');
    const explorerWorktree = path.resolve(dir, '.gh-maestro', 'worktrees', 'issue-5-explore');
    assert.deepEqual(events, [
      ['close-pane-command', process.execPath, [workerStatusScript, 'close-pane', '--workspace', coderWorktree, '--issue', '5'], coderWorktree],
      ['remove-worker', dir, 'issue-5-coder'],
      ['close-pane-command', process.execPath, [workerStatusScript, 'close-pane', '--workspace', explorerWorktree, '--issue', '5'], explorerWorktree],
      ['remove-worker', dir, 'issue-5-explore'],
      ['close-issue', 5],
      ['close-pane-command', process.execPath, [workerStatusScript, 'close-pane', '--workspace', dir, '--issue', '5'], dir],
    ]);
  });
});

test('finalizeIssue: worker worktree の監視ペイン終了失敗時はworkerとIssueを残す', () => {
  withTempWorkspace({
    'issue-5-coder': { paneId: '1', issue: 5 },
  }, (dir) => {
    const worktree = path.resolve(dir, '.gh-maestro', 'worktrees', 'issue-5-coder');
    fs.mkdirSync(worktree, { recursive: true });
    let removeCalls = 0;
    let issueCloseCalls = 0;

    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      {
        closeStatusPaneFn: () => ({ ok: false, stderr: 'pane unavailable' }),
        removeWorkerFn: () => { removeCalls += 1; return { ok: true }; },
        closeIssueFn: () => { issueCloseCalls += 1; return { ok: true }; },
        findReviewPrsFn: () => [],
      },
    );

    assert.equal(result.closed, false);
    assert.deepEqual(result.workerStatusPaneFailures, [{ name: 'issue-5-coder', reason: 'pane unavailable' }]);
    assert.equal(result.artifacts, null);
    assert.equal(removeCalls, 0);
    assert.equal(issueCloseCalls, 0);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8')),
      { 'issue-5-coder': { paneId: '1', issue: 5 } },
    );
    assert.ok(fs.existsSync(worktree));
  });
});

test('finalize-issue CLI: worktree runtimeのclose-pane失敗を非0で報告し、記録を保って再実行できる', () => {
  withTempWorkspace({
    'issue-5-coder': { paneId: '1', issue: 5 },
  }, (dir) => {
    const worktree = path.resolve(dir, '.gh-maestro', 'worktrees', 'issue-5-coder');
    const runtimeDir = path.join(dir, 'isolated-runtime');
    const decisionFile = path.join(dir, 'decision.md');
    fs.writeFileSync(decisionFile, '実機確認テストの決定事項\n', 'utf8');
    const statusPaneRegistry = require('../scripts/shared/status-pane-registry');
    fs.mkdirSync(worktree, { recursive: true });
    const statusFile = statusPaneRegistry.statusPanePath(worktree, runtimeDir);
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, '{invalid json', 'utf8');
    const fakeGh = fakeGhEnvironment(path.join(dir, 'fake'));
    const cliArgs = [
      path.join(__dirname, '..', 'scripts', 'finalize-issue.js'),
      '--issue', '5',
      '--decision-file', decisionFile,
      '--repo', 'test/repo',
      '--workspace', dir,
    ];

    const savedRuntimeDir = process.env.GH_MAESTRO_RUNTIME_DIR;
    process.env.GH_MAESTRO_RUNTIME_DIR = runtimeDir;
    try {
      const cliResult = spawnNodeSync(
        process.execPath,
        cliArgs,
        { encoding: 'utf8', env: { ...fakeGh.env, GH_MAESTRO_RUNTIME_DIR: runtimeDir } },
      );
      assert.equal(cliResult.status, 1);
      assert.match(cliResult.stdout, /FINALIZED:5 removed=0\/1 closed=false/, cliResult.stderr);
      assert.match(cliResult.stderr, /ワーカー "issue-5-coder" の監視ペイン終了に失敗しました/);
      assert.ok(cliResult.stderr.includes(statusFile), '失敗理由にworktree runtimeの記録パスを含める');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8')),
        { 'issue-5-coder': { paneId: '1', issue: 5 } },
      );
      assert.ok(fs.existsSync(worktree), 'close-pane失敗時はworktreeを残す');

      // 壊れた一時 runtime 記録を隔離テスト内で解消し、同じ finalize を再実行する。
      fs.rmSync(statusFile);
      let issueCloseCalls = 0;
      const retryResult = finalizeIssue(
        { workspace: dir, issue: 5 },
        {
          removeWorkerFn: (workspace, name) => {
            const workersFile = path.join(workspace, '.gh-maestro', 'workers.json');
            const workers = JSON.parse(fs.readFileSync(workersFile, 'utf8'));
            delete workers[name];
            fs.writeFileSync(workersFile, JSON.stringify(workers, null, 2));
            fs.rmSync(worktree, { recursive: true, force: true });
            return { ok: true };
          },
          closeIssueFn: () => {
            issueCloseCalls += 1;
            return { ok: true };
          },
          findReviewPrsFn: () => [],
        },
      );

      assert.equal(retryResult.closed, true);
      assert.deepEqual(retryResult.workerStatusPaneFailures, []);
      assert.equal(issueCloseCalls, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8')), {});
      assert.equal(fs.existsSync(worktree), false);
    } finally {
      if (savedRuntimeDir === undefined) delete process.env.GH_MAESTRO_RUNTIME_DIR;
      else process.env.GH_MAESTRO_RUNTIME_DIR = savedRuntimeDir;
    }
  });
});

test('finalize-issue CLI: --decision-fileは必須で空ファイルも拒否する', () => {
  withTempWorkspace({}, (dir) => {
    const script = path.join(__dirname, '..', 'scripts', 'finalize-issue.js');
    const missing = spawnNodeSync(process.execPath, [script, '--issue', '5', '--workspace', dir], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--decision-file/);

    const emptyFile = path.join(dir, 'empty-decision.md');
    fs.writeFileSync(emptyFile, '  \n', 'utf8');
    const empty = spawnNodeSync(process.execPath, [script, '--issue', '5', '--decision-file', emptyFile, '--workspace', dir], { encoding: 'utf8' });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /決定事項ファイルが空/);
  });
});

test('finalizeIssue: 監視ペイン終了の失敗はIssueクローズを失敗扱いにしない', () => {
  withTempWorkspace({}, (dir) => {
    const result = finalizeIssue(
      { workspace: dir, issue: 471 },
      {
        closeIssueFn: () => ({ ok: true }),
        closeStatusPaneFn: () => ({ ok: false, stderr: 'wezterm unavailable' }),
        findReviewPrsFn: () => [],
      },
    );
    assert.equal(result.closed, true);
    assert.equal(result.statusPaneClosed, false);
  });
});

test('finalizeIssue: 実物のremove-workerへworkerNameを位置引数で渡し、削除が成功する', () => {
  withTempWorkspace({
    'issue-5-coder': { issue: 5, skill: 'gh-maestro-coder' },
  }, (dir) => {
    // defaultRemoveWorker は子プロセスへ --workspace を渡す。明示引数が優先される
    // ことを固定しつつ、子プロセスが引数を省略する経路にも実workspaceを継承させない。
    const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
    delete process.env.GH_MAESTRO_WORKSPACE;
    try {
      const result = finalizeIssue(
        { workspace: dir, issue: 5 },
        {
          // removeWorkerFn を注入しないことで、実物の defaultRemoveWorker と
          // finalize-issue.js → remove-worker.js の引数境界を通す。
          closeStatusPaneFn: () => ({ ok: true }),
          closeIssueFn: () => ({ ok: true }),
          findReviewPrsFn: () => [],
        }
      );
      assert.deepEqual(result.workers, [{ name: 'issue-5-coder', ok: true }]);
      assert.equal(result.removedCount, 1);
      assert.equal(result.closed, true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.gh-maestro', 'workers.json'), 'utf8'))['issue-5-coder'], undefined);
    } finally {
      if (savedWorkspace === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
      else process.env.GH_MAESTRO_WORKSPACE = savedWorkspace;
    }
  });
});

test('finalizeIssue: ワーカー削除が一部失敗してもIssueは閉じる（best-effort）', () => {
  withTempWorkspace({
    'issue-5-coder': { paneId: '1', issue: 5 },
    'issue-5-explore': { paneId: '2', issue: 5 },
  }, (dir) => {
    let closed = false;
    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      {
        removeWorkerFn: (ws, name) => ({ ok: name !== 'issue-5-explore', stderr: 'boom' }),
        closeIssueFn: () => { closed = true; return { ok: true }; },
        closeStatusPaneFn: () => ({ ok: true }),
        findReviewPrsFn: () => [],
      }
    );
    assert.equal(result.removedCount, 1);
    assert.equal(result.closed, true);
    assert.equal(closed, true);
  });
});

test('finalizeIssue: ワーカーが無くてもIssueは閉じる', () => {
  withTempWorkspace({ orchestrator: { paneId: '0' } }, (dir) => {
    let closed = false;
    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      { closeIssueFn: () => { closed = true; return { ok: true }; }, findReviewPrsFn: () => [] }
    );
    assert.equal(result.workers.length, 0);
    assert.equal(result.removedCount, 0);
    assert.equal(closed, true);
  });
});

test('finalizeIssue: Issueクローズ失敗は closed:false で返る', () => {
  withTempWorkspace({ 'issue-5-coder': { paneId: '1', issue: 5 } }, (dir) => {
    const result = finalizeIssue(
      { workspace: dir, issue: 5 },
      {
        removeWorkerFn: () => ({ ok: true }),
        closeIssueFn: () => ({ ok: false, stderr: 'gh error' }),
        closeStatusPaneFn: () => ({ ok: true }),
        findReviewPrsFn: () => [],
      }
    );
    assert.equal(result.closed, false);
  });
});

test('finalizeIssue: assistantを終了しない', () => {
  withTempWorkspace({}, (dir) => {
    let closeCalled = false;
    let killAssistantCalled = false;
    const result = finalizeIssue(
      { workspace: dir, issue: 9 },
      {
        closeIssueFn: () => { closeCalled = true; return { ok: true }; },
        killAssistantFn: () => { killAssistantCalled = true; return { ok: false }; },
        findReviewPrsFn: () => [],
      }
    );
    assert.equal(closeCalled, true);
    assert.equal(killAssistantCalled, false);
    assert.equal(result.closed, true);
    assert.equal(Object.hasOwn(result, 'assistantKilled'), false);
  });
});

// ── Issue #248: cleanupIssueArtifacts（項目2/4/7） ─────────────────────────

test('cleanupIssueArtifacts: 対象issueの assistant-watch/<N>.json を削除する（項目2）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const watchDir = path.join(dir, '.gh-maestro', 'records', 'issue');
    fs.mkdirSync(path.join(watchDir, '42'), { recursive: true });
    fs.mkdirSync(path.join(watchDir, '99'), { recursive: true });
    fs.writeFileSync(path.join(watchDir, '42', 'assistant-watch.json'), '{}');
    fs.writeFileSync(path.join(watchDir, '99', 'assistant-watch.json'), '{}');
    const result = cleanupIssueArtifacts(dir, 42, { findReviewPrsFn: () => [] });
    assert.equal(result.watchRemoved, true);
    assert.ok(!fs.existsSync(path.join(watchDir, '42', 'assistant-watch.json')));
    assert.ok(fs.existsSync(path.join(watchDir, '99', 'assistant-watch.json')), '他のissueのwatchファイルは残す');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupIssueArtifacts: 対象PRの review-manager-<PR>.incomplete を削除し、無関係PRは残す（項目4）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const ghDir = path.join(dir, '.gh-maestro');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'records', 'pr', '123', 'review'), { recursive: true });
    fs.mkdirSync(path.join(ghDir, 'records', 'pr', '999', 'review'), { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'records', 'pr', '123', 'review', 'manager.incomplete'), 'done');
    fs.writeFileSync(path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.incomplete'), 'done');
    const result = cleanupIssueArtifacts(dir, 7, { findReviewPrsFn: () => [123] });
    assert.deepEqual(result.incompleteRemoved, [123]);
    assert.ok(!fs.existsSync(path.join(ghDir, 'records', 'pr', '123', 'review', 'manager.incomplete')));
    assert.ok(fs.existsSync(path.join(ghDir, 'records', 'pr', '999', 'review', 'manager.incomplete')), '無関係PRのセンチネルは残す');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupIssueArtifacts: executions.json の対象issueレコードだけを間引き、ファイル自体は残す（項目7）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const { startExecution, readRegistry } = require('../scripts/shared/execution-registry');
    startExecution(dir, { executionId: 'issue-7-a', issue: 7, workerName: 'w-a', skill: 'gh-maestro-coder' });
    startExecution(dir, { executionId: 'issue-9', issue: 9, workerName: 'w-b', skill: 'gh-maestro-coder' });
    const result = cleanupIssueArtifacts(dir, 7, { findReviewPrsFn: () => [] });
    assert.equal(result.executionsPruned, 1);
    const after = readRegistry(dir);
    assert.ok(!('issue-7-a' in after));
    assert.ok('issue-9' in after);
    assert.ok(fs.existsSync(path.join(dir, '.gh-maestro', 'executions.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupIssueArtifacts: findReviewPrsFnが例外を投げても他項目は続行する（best-effort）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-finalize-'));
  try {
    const watchDir = path.join(dir, '.gh-maestro', 'records', 'issue', '5');
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(path.join(watchDir, 'assistant-watch.json'), '{}');
    const result = cleanupIssueArtifacts(dir, 5, { findReviewPrsFn: () => { throw new Error('gh down'); } });
    assert.equal(result.watchRemoved, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Issue #248レビュー指摘1: PR本文の #<issue> 厳密一致（前方一致を許さない） ──

test('bodyReferencesIssue: 正確な "#<issue>" 参照を検出する', () => {
  assert.equal(bodyReferencesIssue('Closes #1', 1), true);
  assert.equal(bodyReferencesIssue('Fixes #1\nSee body', 1), true);
  assert.equal(bodyReferencesIssue('ref #42.', 42), true);
  // 直後に数字以外が続くものは「別の番号の一部」ではないため参照として検出する（単語境界ルール）
  assert.equal(bodyReferencesIssue('see #1x (not an issue ref)', 1), true);
});

test('bodyReferencesIssue: "#<issue>" の直後に数字が続く前方一致は誤検出しない', () => {
  // Issue #1 の finalize 時に #12・#123 を参照するPRを誤って拾わない
  assert.equal(bodyReferencesIssue('Closes #12', 1), false);
  assert.equal(bodyReferencesIssue('related #123', 1), false);
  assert.equal(bodyReferencesIssue('Closes #123', 12), false);
});

test('bodyReferencesIssue: 本文が文字列でなければfalse', () => {
  assert.equal(bodyReferencesIssue(null, 1), false);
  assert.equal(bodyReferencesIssue(undefined, 1), false);
  assert.equal(bodyReferencesIssue(123, 1), false);
});
