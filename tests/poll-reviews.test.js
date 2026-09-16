'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  main,
  isValidCommentId,
  isValidPrCommentId,
  buildPrCommentRelayEvents,
  formatTestStatusEvent,
  pollReviewsStateFiles,
  runPollReviews,
} = require('../scripts/poll-reviews.js');

test('isValidCommentId: 正の整数IDだけを受理する', () => {
  assert.equal(isValidCommentId('12345'), true);
  assert.equal(isValidCommentId('1'), true);
});

test('isValidCommentId: GitHubエラーレスポンス由来のゴミ断片を弾く', () => {
  // 実障害: GitHub障害中に 404 JSON や切れた出力の断片が state 記録・中継された
  assert.equal(isValidCommentId('}'), false);
  assert.equal(isValidCommentId(''), false);
  assert.equal(isValidCommentId('{"message": "Not Found"'), false);
  assert.equal(isValidCommentId('  '), false);
  assert.equal(isValidCommentId('12a'), false);
  assert.equal(isValidCommentId('-1'), false);
});

test('isValidPrCommentId: GraphQLの不透明なPRコメントIDを受理する', () => {
  assert.equal(isValidPrCommentId('IC_kwDOSr7Ezc8AAAABPxKo7g'), true);
  assert.equal(isValidPrCommentId('opaque-global-node-id'), true);
});

test('isValidPrCommentId: 欠落・空白のPRコメントIDを拒否する', () => {
  assert.equal(isValidPrCommentId(undefined), false);
  assert.equal(isValidPrCommentId(null), false);
  assert.equal(isValidPrCommentId(''), false);
  assert.equal(isValidPrCommentId('  '), false);
});

test('buildPrCommentRelayEvents: GraphQL IDのPRコメントを中継し、既読・不正コメントは除外する', () => {
  const known = new Set(['IC_known']);
  const comments = [
    { id: 'IC_new', author: { login: 'reviewer' }, body: 'レビュー\n停止理由' },
    { id: 'IC_known', author: { login: 'reviewer' }, body: '既読' },
    { id: '', author: { login: 'reviewer' }, body: 'IDなし' },
    { author: { login: 'reviewer' }, body: 'ID欠落' },
  ];

  assert.deepEqual(buildPrCommentRelayEvents(comments, known), [
    { id: 'IC_new', line: 'PR_COMMENT:reviewer:レビュー 停止理由' },
  ]);
});

const { pollDegradationTransition } = require('../scripts/poll-reviews.js');

test('pollDegradationTransition: 正常→劣化の遷移でPOLL_ERRORを一度だけ発火', () => {
  assert.deepEqual(pollDegradationTransition(false, true), { degraded: true, emit: 'POLL_ERROR' });
  // 劣化継続中は再発火しない（スパム防止）
  assert.deepEqual(pollDegradationTransition(true, true), { degraded: true, emit: null });
});

test('pollDegradationTransition: 劣化→復旧の遷移でPOLL_RECOVEREDを一度だけ発火', () => {
  assert.deepEqual(pollDegradationTransition(true, false), { degraded: false, emit: 'POLL_RECOVERED' });
  // 正常継続中は何も出さない
  assert.deepEqual(pollDegradationTransition(false, false), { degraded: false, emit: null });
});

// ── reviewTerminalEvent（Issue #289: CLOSED も終端として扱う） ──────────────
const { reviewTerminalEvent } = require('../scripts/poll-reviews.js');

test('reviewTerminalEvent: MERGED は PR_MERGED として終端', () => {
  assert.equal(reviewTerminalEvent('MERGED', '12'), 'PR_MERGED:12');
});

test('reviewTerminalEvent: CLOSED（却下・キャンセル）も PR_CLOSED として終端', () => {
  // Issue #289: 従来は MERGED のみ終端だったため、CLOSED された PR を監視し続けて
  // 機能死を起こした。CLOSED も終端にすることで新 PR 検出へ戻れる。
  assert.equal(reviewTerminalEvent('CLOSED', '12'), 'PR_CLOSED:12');
});

test('reviewTerminalEvent: OPEN 等の非終端状態は null（監視継続）', () => {
  assert.equal(reviewTerminalEvent('OPEN', '12'), null);
  assert.equal(reviewTerminalEvent('DRAFT', '12'), null);
  assert.equal(reviewTerminalEvent('', '12'), null);
});

// ── extractTestDeclaration & evaluateTestDeclaration ────────────────────────
const { extractTestDeclaration, evaluateTestDeclaration } = require('../scripts/poll-reviews.js');
const { TEST_RESULT_MARKER, LEGACY_TEST_RESULT_MARKER } = require('../scripts/shared/test-declaration');

function fullDeclarationBody(commit = 'a1b2c3d4e5', fail = 0, pass = 1826, scope = 'full') {
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${fail === 0 ? 'pass' : 'fail'} (fail: ${fail}, pass: ${pass})
- **実行件数**: \`${fail + pass}\`
- **実行元**: \`test-runner\`
- **実行範囲**: \`${scope}\``;
}

function aggregateDeclarationBody(commit = 'a1b2c3d4e5f6') {
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: pass
- **実行元**: \`test-runner\`
- **実行範囲**: \`aggregate\`
- **層別結果**:
  - **full**: pass (fail: 0, pass: 1826), tests: 1826, executor: \`test-runner\`, scope: \`full\`
  - **slow**: pass (fail: 0, pass: 10), tests: 10, executor: \`poll-pr\`, scope: \`partial\`, 実行記録: \`C:/runtime/slow.log\``;
}

test('extractTestDeclaration: 申告マーカーがないコメントは null', () => {
  assert.equal(extractTestDeclaration('普通のコメント'), null);
  assert.equal(extractTestDeclaration(''), null);
  assert.equal(extractTestDeclaration(null), null);
});

test('formatTestStatusEvent: provenance/scope をTEST_STATUS通知へ含める', () => {
  assert.equal(
    formatTestStatusEvent({
      status: 'GREEN',
      declaredSha: 'a1b2c3d',
      headSha: 'a1b2c3d4e5f6',
      provenance: 'test-runner',
      scope: 'full',
    }),
    'TEST_STATUS:GREEN:a1b2c3d:a1b2c3d4e5f6:test-runner:full',
  );
  assert.equal(
    formatTestStatusEvent({ status: 'NONE', provenance: 'unknown', scope: 'unknown' }),
    'TEST_STATUS:NONE:none:none:unknown:unknown',
  );
  const aggregateEvaluation = evaluateTestDeclaration(
    extractTestDeclaration(aggregateDeclarationBody()),
    'a1b2c3d4e5f6',
  );
  assert.equal(
    formatTestStatusEvent(aggregateEvaluation),
    'TEST_STATUS:GREEN:a1b2c3d4e5f6:a1b2c3d4e5f6:test-runner:aggregate',
  );
});

test('poll-reviews: aggregate通知と共有評価は層別結果を保持する', () => {
  const evaluation = evaluateTestDeclaration(
    extractTestDeclaration(aggregateDeclarationBody()),
    'a1b2c3d4e5f6',
  );
  assert.equal(evaluation.scope, 'aggregate');
  assert.equal(evaluation.layers.full.pass, 1826);
  assert.equal(evaluation.layers.slow.executor, 'poll-pr');
  assert.equal(evaluation.allLayersPresent, true);
  assert.equal(evaluation.allLayersComplete, true);
});

test('extractTestDeclaration: v2 から commit, fail, pass, provenance, scope を抽出する', () => {
  const decl = extractTestDeclaration(fullDeclarationBody());
  assert.deepEqual(decl, {
    version: 2,
    commit: 'a1b2c3d4e5',
    outcome: 'pass',
    fail: 0,
    pass: 1826,
    tests: 1826,
    provenance: 'test-runner',
    scope: 'full',
  });
});

test('extractTestDeclaration: v1 の値は読めても実行範囲は unknown', () => {
  const body = `${LEGACY_TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`a1b2c3d\`
- **結果**: fail (fail: 2)`;
  assert.deepEqual(extractTestDeclaration(body), {
    version: 1,
    commit: 'a1b2c3d',
    fail: 2,
    pass: undefined,
    provenance: 'unknown',
    scope: 'unknown',
  });
});

test('extractTestDeclaration: provenance/scope が欠落した v2 は unknown へ縮退する', () => {
  const body = `${TEST_RESULT_MARKER}
- **対象コミット**: \`a1b2c3d\`
- **結果**: pass (fail: 0, pass: 10)`;
  assert.deepEqual(extractTestDeclaration(body), {
    version: 2,
    commit: 'a1b2c3d',
    provenance: 'unknown',
    scope: 'unknown',
    fail: undefined,
    pass: undefined,
  });
});

test('evaluateTestDeclaration: 申告なし → NONE と none metadata', () => {
  const res = evaluateTestDeclaration(null, 'a1b2c3d4e5');
  assert.deepEqual(res, {
    status: 'NONE',
    headSha: 'a1b2c3d4e5',
    provenance: 'none',
    scope: 'none',
  });
});

test('evaluateTestDeclaration: headSha が空の場合は STALE ではなく NONE', () => {
  const decl = { commit: 'a1b2c3d', fail: 0, pass: 100, provenance: 'test-runner', scope: 'full' };
  assert.deepEqual(evaluateTestDeclaration(decl, ''), {
    status: 'NONE',
    declaredSha: 'a1b2c3d',
    headSha: undefined,
    fail: 0,
    pass: 100,
    provenance: 'test-runner',
    scope: 'full',
  });
});

test('evaluateTestDeclaration: コミット不一致 → STALE', () => {
  const decl = { commit: '1111111', fail: 0, pass: 100, provenance: 'test-runner', scope: 'full' };
  const res = evaluateTestDeclaration(decl, '2222222');
  assert.equal(res.status, 'STALE');
  assert.equal(res.provenance, 'test-runner');
  assert.equal(res.scope, 'full');
});

test('evaluateTestDeclaration: コミット一致かつ fail 0 → GREEN', () => {
  const decl = { commit: 'a1b2c3d', fail: 0, pass: 100, provenance: 'test-runner', scope: 'full' };
  const res = evaluateTestDeclaration(decl, 'a1b2c3d4e5f6');
  assert.equal(res.status, 'GREEN');
  assert.equal(res.provenance, 'test-runner');
  assert.equal(res.scope, 'full');
});

test('evaluateTestDeclaration: コミット一致かつ fail > 0 → RED', () => {
  const decl = { commit: 'a1b2c3d4e5f6', fail: 1, pass: 99, provenance: 'test-runner', scope: 'partial' };
  const res = evaluateTestDeclaration(decl, 'a1b2c3d4e5f6');
  assert.equal(res.status, 'RED');
  assert.equal(res.fail, 1);
  assert.equal(res.scope, 'partial');
});

test('extractTestDeclaration: 形式不正や欠落のあるコメントを安全に弾く', () => {
  assert.equal(extractTestDeclaration(`${LEGACY_TEST_RESULT_MARKER}\n対象コミットなし`), null);
  assert.equal(extractTestDeclaration(`${LEGACY_TEST_RESULT_MARKER}\n- **対象コミット**: \`1234567\`\n- 結果: 不明`), null);
  assert.equal(extractTestDeclaration({}), null);
  assert.equal(extractTestDeclaration(123), null);
});

// ── CLI: workspace 解決（サブプロセス経由） ─────────────────────────────────
// workspace 解決は gh 呼び出しより前に行われるため、この検証だけなら実 gh 呼び出しは発生しない。

const path = require('path');
const { spawnSync } = require('child_process');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

const pollReviewsScript = path.join(__dirname, '../scripts/poll-reviews.js');
const tempDirScope = createTempDirScope();

test.after(() => tempDirScope.cleanup());

// ── CLI 引数境界テスト ───────────────────────────────────────────────────

test('CLI: --help 表示に --no-review-manager が含まれ exit 0', () => {
  const res = spawnSync(process.execPath, [pollReviewsScript, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes('--no-review-manager'));
});

test('CLI: 未知のフラグを指定すると非ゼロで exit', () => {
  const res = spawnSync(process.execPath, [pollReviewsScript, '12', '--unknown-flag'], { encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('未知の引数') || res.stderr.includes('--unknown-flag'));
});

test('CLI: --no-review-manager は未知フラグにならずパースされる', () => {
  // PR番号なしで実行した場合は Usage で exit 1
  const res = spawnSync(process.execPath, [pollReviewsScript, '--no-review-manager'], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes('poll-reviews: 位置引数が必要です'));
});

test('CLI: --no-review-manager フラグを指定すると runPollReviews に noReviewManager=true が渡る', async () => {
  let capturedParams = null;
  const res = await main(['100', '/test/workspace', '--no-review-manager'], {
    resolveWorkspaceFn: (ws) => ws,
    resolveSessionPidFn: () => 12345,
    getProcessStartTimeFn: () => null,
    createDeadManSwitchFn: () => () => true,
    registerProcessFn: () => {},
    registerSignalHandlers: false,
    pollReviewsStateFilesFn: () => ({ files: [] }),
    runPollReviewsFn: async (params) => {
      capturedParams = params;
      return { exitCode: 0 };
    },
  });

  assert.equal(res.exitCode, 0);
  assert.ok(capturedParams, 'runPollReviews must be called');
  assert.equal(capturedParams.pr, '100');
  assert.equal(capturedParams.workspace, '/test/workspace');
  assert.equal(capturedParams.noReviewManager, true);
});

test('CLI: --no-review-manager フラグを省略すると runPollReviews に noReviewManager=false が渡る', async () => {
  let capturedParams = null;
  const res = await main(['100', '/test/workspace'], {
    resolveWorkspaceFn: (ws) => ws,
    resolveSessionPidFn: () => 12345,
    getProcessStartTimeFn: () => null,
    createDeadManSwitchFn: () => () => true,
    registerProcessFn: () => {},
    registerSignalHandlers: false,
    pollReviewsStateFilesFn: () => ({ files: [] }),
    runPollReviewsFn: async (params) => {
      capturedParams = params;
      return { exitCode: 0 };
    },
  });

  assert.equal(res.exitCode, 0);
  assert.ok(capturedParams, 'runPollReviews must be called');
  assert.equal(capturedParams.pr, '100');
  assert.equal(capturedParams.workspace, '/test/workspace');
  assert.equal(capturedParams.noReviewManager, false);
});

test('CLI: 子プロセス起動で --no-review-manager 引数が runPollReviews まで渡る', () => {
  const probe = `
    const { main } = require(${JSON.stringify(pollReviewsScript)});
    main(['100', '/test/workspace', '--no-review-manager'], {
      resolveWorkspaceFn: (w) => w,
      resolveSessionPidFn: () => 12345,
      getProcessStartTimeFn: () => null,
      createDeadManSwitchFn: () => () => true,
      registerProcessFn: () => {},
      registerSignalHandlers: false,
      pollReviewsStateFilesFn: () => ({ files: [] }),
      runPollReviewsFn: async (params) => {
        process.stdout.write(JSON.stringify(params));
        return { exitCode: 0 };
      },
    });
  `;
  const res = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.noReviewManager, true);
  assert.equal(parsed.pr, '100');
  assert.equal(parsed.workspace, '/test/workspace');
});

// ── runPollReviews: --no-review-manager 振る舞い ───────────────────────────

test('runPollReviews: noReviewManager=true のとき inline comments と formal reviews API を呼び出さない', async () => {
  const tmpDir = tempDirScope.mkdtemp('poll-reviews-unit-');
  const calledGhArgs = [];
  const stdoutLines = [];

  const mockGhCapture = (args) => {
    calledGhArgs.push(args);
    const cmd = args.join(' ');
    if (cmd.includes('pr view 100 --repo owner/repo --json state,headRefOid,author')) {
      return 'OPEN|a1b2c3d4e5|alice\n';
    }
    if (cmd.includes('pr view 100 --repo owner/repo --json comments')) {
      return JSON.stringify({
        comments: [
          {
            id: 'IC_1',
            author: { login: 'alice' },
            body: fullDeclarationBody('a1b2c3d4e5', 0, 10, 'full'),
          },
        ],
      });
    }
    if (cmd.includes('comments')) {
      return '1|file.js|10|bob|inline comment\n';
    }
    if (cmd.includes('reviews')) {
      return '2|bob|APPROVED|looks good\n';
    }
    return '';
  };

  const res = await runPollReviews({
    pr: 100,
    workspace: tmpDir,
    sessionPid: process.pid,
    intervalSec: 1,
    noReviewManager: true,
    maxCycles: 1,
  }, {
    ghCaptureFn: mockGhCapture,
    repo: 'owner/repo',
    checkParentFn: () => true,
    writeStdoutFn: (text) => stdoutLines.push(text),
    sleepFn: () => Promise.resolve(),
  });

  assert.equal(res.exitCode, 0);

  // inline comments API と formal reviews API の呼び出しが無いことを検証
  const calledApis = calledGhArgs.map(a => a.join(' '));
  assert.ok(!calledApis.some(cmd => cmd.includes('pulls/100/comments')), 'inline comments API must not be called');
  assert.ok(!calledApis.some(cmd => cmd.includes('pulls/100/reviews')), 'formal reviews API must not be called');

  // state, headRefOid, author の取得は呼ばれていること
  assert.ok(calledApis.some(cmd => cmd.includes('pr view 100') && cmd.includes('headRefOid')));
  // comments の取得（テスト申告評価用）は呼ばれていること
  assert.ok(calledApis.some(cmd => cmd.includes('pr view 100') && cmd.includes('--json comments')));

  // TEST_STATUS が出力されていること
  assert.ok(stdoutLines.some(line => line.includes('TEST_STATUS:GREEN:a1b2c3d4e5:a1b2c3d4e5:test-runner:full')));
  // REVIEW_COMMENT や PR_REVIEW が出力されていないこと
  assert.ok(!stdoutLines.some(line => line.includes('REVIEW_COMMENT')));
  assert.ok(!stdoutLines.some(line => line.includes('PR_REVIEW')));
});

test('runPollReviews: noReviewManager=false のとき inline comments と formal reviews API を呼び出す', async () => {
  const tmpDir = tempDirScope.mkdtemp('poll-reviews-full-');
  const calledGhArgs = [];
  const stdoutLines = [];

  const mockGhCapture = (args) => {
    calledGhArgs.push(args);
    const cmd = args.join(' ');
    if (cmd.includes('pr view 100 --repo owner/repo --json state,headRefOid,author')) {
      return 'OPEN|sha123|alice\n';
    }
    if (cmd.includes('pr view 100 --repo owner/repo --json comments')) {
      return JSON.stringify({ comments: [] });
    }
    if (cmd.includes('pulls/100/comments')) {
      return '1|file.js|10|bob|inline comment\n';
    }
    if (cmd.includes('pulls/100/reviews')) {
      return '2|charlie|APPROVED|looks good\n';
    }
    return '';
  };

  const res = await runPollReviews({
    pr: 100,
    workspace: tmpDir,
    sessionPid: process.pid,
    intervalSec: 1,
    noReviewManager: false,
    maxCycles: 1,
  }, {
    ghCaptureFn: mockGhCapture,
    repo: 'owner/repo',
    checkParentFn: () => true,
    writeStdoutFn: (text) => stdoutLines.push(text),
    sleepFn: () => Promise.resolve(),
  });

  assert.equal(res.exitCode, 0);

  const calledApis = calledGhArgs.map(a => a.join(' '));
  assert.ok(calledApis.some(cmd => cmd.includes('pulls/100/comments')), 'inline comments API must be called');
  assert.ok(calledApis.some(cmd => cmd.includes('pulls/100/reviews')), 'formal reviews API must be called');

  // REVIEW_COMMENT と PR_REVIEW が出力されていること
  assert.ok(stdoutLines.some(line => line.includes('REVIEW_COMMENT:file.js|10|bob|inline comment')));
  assert.ok(stdoutLines.some(line => line.includes('PR_REVIEW:charlie:APPROVED:looks good')));
});

test('runPollReviews: noReviewManager=true でも MERGED / CLOSED 終端検出が動作する', async () => {
  const tmpDir = tempDirScope.mkdtemp('poll-reviews-terminal-');
  const stdoutLines = [];

  const mockGhCapture = (args) => {
    const cmd = args.join(' ');
    if (cmd.includes('pr view 100 --repo owner/repo --json state,headRefOid,author')) {
      return 'MERGED|sha123|alice\n';
    }
    return '';
  };

  const res = await runPollReviews({
    pr: 100,
    workspace: tmpDir,
    sessionPid: process.pid,
    intervalSec: 1,
    noReviewManager: true,
    maxCycles: 1,
  }, {
    ghCaptureFn: mockGhCapture,
    repo: 'owner/repo',
    checkParentFn: () => true,
    writeStdoutFn: (text) => stdoutLines.push(text),
    sleepFn: () => Promise.resolve(),
  });

  assert.equal(res.exitCode, 0);
  assert.equal(res.terminalEvent, 'PR_MERGED:100');
  assert.ok(stdoutLines.some(line => line.includes('PR_MERGED:100')));
});

test('pollReviewsStateFiles: 状態ファイルのパス定義を一元的に払い出し、files配列に全ファイルを含む', () => {
  const ws = path.join('fake', 'workspace');
  const pr = 42;
  const paths = pollReviewsStateFiles(ws, pr);
  assert.equal(paths.stateDir, path.join(ws, '.gh-maestro'));
  assert.equal(paths.stateFile, path.join(ws, '.gh-maestro', 'poll-state-42'));
  assert.equal(paths.shaFile, path.join(ws, '.gh-maestro', 'poll-sha-42'));
  assert.equal(paths.testStatusFile, path.join(ws, '.gh-maestro', 'poll-test-status-42'));
  assert.deepEqual(paths.files, [paths.stateFile, paths.shaFile, paths.testStatusFile]);
});

