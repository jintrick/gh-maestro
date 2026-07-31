'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isValidCommentId } = require('../scripts/poll-reviews.js');

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

// ── CLI: workspace 解決（サブプロセス経由） ─────────────────────────────────
// workspace 解決は gh 呼び出しより前に行われるため、この検証だけなら実 gh 呼び出しは発生しない。

test('[WORKSPACE] 位置引数がホームディレクトリと衝突する場合、生の例外ではなくワークスペース解決エラーで exit 1 する（Issue #214）', () => {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-fakehome-'));
  try {
    const script = path.join(__dirname, '..', 'scripts', 'poll-reviews.js');
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
