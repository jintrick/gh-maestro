'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidCommentId,
  isValidPrCommentId,
  buildPrCommentRelayEvents,
  formatTestStatusEvent,
} = require('../../scripts/poll-reviews.js');

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

const { pollDegradationTransition } = require('../../scripts/poll-reviews.js');

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
const { reviewTerminalEvent } = require('../../scripts/poll-reviews.js');

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
const { extractTestDeclaration, evaluateTestDeclaration } = require('../../scripts/poll-reviews.js');
const { TEST_RESULT_MARKER, LEGACY_TEST_RESULT_MARKER } = require('../../scripts/shared/test-declaration');

function fullDeclarationBody(commit = 'a1b2c3d4e5', fail = 0, pass = 1826, scope = 'full') {
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${fail === 0 ? 'pass' : 'fail'} (fail: ${fail}, pass: ${pass})
- **実行件数**: \`${fail + pass}\`
- **実行元**: \`test-runner\`
- **実行範囲**: \`${scope}\``;
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
});

test('extractTestDeclaration: v2 から commit, fail, pass, provenance, scope を抽出する', () => {
  const decl = extractTestDeclaration(fullDeclarationBody());
  assert.deepEqual(decl, {
    version: 2,
    commit: 'a1b2c3d4e5',
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

test('[WORKSPACE] 位置引数がホームディレクトリと衝突する場合、生の例外ではなくワークスペース解決エラーで exit 1 する（Issue #214）', () => {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-fakehome-'));
  try {
    const script = path.join(__dirname, '..', '..', 'scripts', 'poll-reviews.js');
    const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const env = { ...process.env, [envKey]: fakeHome };
    delete env.GH_MAESTRO_WORKSPACE;

    const r = spawnSync(process.execPath, [script, '999', fakeHome], { encoding: 'utf8', timeout: 10000, env });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /ワークスペースを解決できません/);
    assert.doesNotMatch(r.stderr, /assertValidWorkspace/, `生の例外スタックトレースが漏れてはならない: ${r.stderr}`);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
