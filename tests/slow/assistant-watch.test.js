'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const watch = require('../../scripts/assistant-watch');
const { spawnSync } = require('../../scripts/shared/child-process');
const { reviewArtifactPath } = require('../../scripts/shared/review-manager-paths');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-assistant-watch-test-'));
  // workspace引数を省略する経路も一時ディレクトリへ隔離できるよう、
  // GH_MAESTRO_WORKSPACE のフォールバックをテスト用ディレクトリにする。
  const origWorkspace = process.env.GH_MAESTRO_WORKSPACE;
  process.env.GH_MAESTRO_WORKSPACE = dir;
  const cleanup = () => {
    if (origWorkspace !== undefined) process.env.GH_MAESTRO_WORKSPACE = origWorkspace;
    else delete process.env.GH_MAESTRO_WORKSPACE;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(dir);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

function stubOk(overrides = {}) {
  watch._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }));
  watch._setGhIssueComments(() => ({ status: 0, stdout: JSON.stringify([]), stderr: '' }));
  watch._setGhFindPr(() => []);
  watch._setGhPrView(() => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }), stderr: '' }));
  // テスト用時計を進めるだけにし、実時間のtimeout待機を発生させない。
  let now = 0;
  watch._setNow(() => now);
  // 500msずつ進めることで、3秒の論理待機内に閾値(5回)だけを通過させる。
  watch._setSleep(async () => { now += 500; });
  watch._setWriteState(watch.writeState);
  Object.entries(overrides).forEach(([k, v]) => {
    if (k === 'ghRepoView') watch._setGhRepoView(v);
    if (k === 'ghIssueComments') watch._setGhIssueComments(v);
    if (k === 'ghFindPr') watch._setGhFindPr(v);
    if (k === 'ghPrView') watch._setGhPrView(v);
  });
}

function commentEntry({ id, from, to = 'orchestrator', body }) {
  const marker = JSON.stringify({ v: 1, to, from });
  return { id, body: body ?? `<!-- gh-maestro ${marker} -->\n> ${from}からの報告です` };
}

// ── parseArgs ────────────────────────────────────────────────────────────

describe('parseArgs', () => {



});

// ── main(): 引数検証 ─────────────────────────────────────────────────────

describe('main: 引数検証', () => {



});

// ── main(): 初回実行はベースライン確立のみ（イベント化しない） ────────────

describe('main: 初回実行のベースライン確立', () => {
});

// ── main(): イベント検知（既存stateがある状態からの差分） ──────────────────

describe('main: worker_report検知', () => {


});

// ── Issue #250: writeState の EPERM 失敗への耐性 ────────────────────────────
// writeState の失敗を注入し、OS依存のatomic-writeリトライ待機をテストへ持ち込まない。

describe('main: writeState失敗耐性', () => {


  // ── PR #251: _notifyOrchestrator が実 msg-send.js コマンドを正しく構築する ──
  // 非ワーカーコンテキストの msg-send.js は宛先を位置引数（recipient）で受け取る。
  // 省略すると recipient が undefined になり usage エラーで必ず送信失敗するため、
  // 「呼ばれたこと」だけでなく「構築されるコマンドライン引数」を検証する。

});

describe('main: hanseikai検知', () => {
});

describe('main: review_done検知', () => {


});

describe('main: pr_merged検知', () => {

});

// ── _ghFindPr: poll-pr.js findPR() と同じ2段構え ────────────────────────

describe('main: PR新規発見のクエリ精度', () => {
});

// ── gh呼び出し失敗時のふるまい ───────────────────────────────────────────

describe('main: gh呼び出し失敗', () => {
});

// ── extractPreview ───────────────────────────────────────────────────────

describe('extractPreview', () => {

});

// ── CLI: --help / 引数不足 ───────────────────────────────────────────────

describe('CLI', () => {
  const { spawnSync } = require('child_process');
  const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'assistant-watch.js');

  test('--help はUsageを表示して終了コード0', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /assistant-watch\.js/);
  });

  test('引数不足はUsageをstderrに出して終了コード1', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--issue/);
  });
});
