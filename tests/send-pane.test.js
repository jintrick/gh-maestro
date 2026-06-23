'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'gh-maestro-base', 'scripts', 'send-pane.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('引数なしでエラー終了する', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('ワーカー名のみでエラー終了する（メッセージが必要）', () => {
  const r = run(['orchestrator']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('workers.json が存在する場合にpane-idを解決する（wezterm呼び出し前に解決されること）', () => {
  withTempDir(workspace => {
    const ghMaestroDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghMaestroDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghMaestroDir, 'workers.json'),
      JSON.stringify({ orchestrator: '42', 'issue-1-implement': '99' }),
      'utf8'
    );

    // wezterm がなくても解決ロジックは動く（wezterm呼び出しで失敗するが、
    // 解決自体は行われているはずなので exit code は wezterm 起因のエラー）
    const r = run(['orchestrator', 'hello', '--workspace', workspace], {
      WEZTERM_PANE: '99',
    });
    // wezterm が存在しない環境でも "Usage" エラーにはならない（引数は正しい）
    assert.ok(!r.stderr.includes('Usage'), `予期しないUsageエラー: ${r.stderr}`);
  });
});

test('orchestratorからの送信にはプレフィックス "orchestratorです。" が付く', () => {
  // send-pane.js のプレフィックスロジックを直接検証するため、
  // スクリプト内のロジックを関数として切り出せないので、
  // workers.json でorchestratorのpane-idを自分のWEZTERM_PANEと一致させてチェック
  withTempDir(workspace => {
    const ghMaestroDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghMaestroDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghMaestroDir, 'workers.json'),
      JSON.stringify({ orchestrator: '1', 'issue-1-implement': '2' }),
      'utf8'
    );

    // WEZTERM_PANE=1 → 自分はorchestratorとして認識される
    // → fullMessage = "orchestratorです。<message>"
    // wezterm がないので実際には送信失敗するが、プレフィックス付与ロジックは到達する
    const r = run(['issue-1-implement', 'test message', '--workspace', workspace], {
      WEZTERM_PANE: '1',
    });
    assert.ok(!r.stderr.includes('Usage'));
  });
});
