'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'poll-and-notify.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-pan-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('引数不足でエラー終了する', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

test('send-pane.js 呼び出し時に WEZTERM_PANE を継承しない（orchestrator誤自己言及の防止）', () => {
  withTempDir(tmp => {
    const workspace = path.join(tmp, 'project');
    fs.mkdirSync(workspace, { recursive: true });

    // poll-pr.js の代わりに1行だけ出力してすぐ終了するモックを用意する
    const fakePollPr = path.join(tmp, 'poll-pr.js');
    fs.writeFileSync(fakePollPr, "console.log('REVIEW_STARTED:480');\n", 'utf8');

    // send-pane.js の代わりに、受け取った env.WEZTERM_PANE を記録するモックを用意する
    const capturedEnvPath = path.join(tmp, 'captured-env.json');
    const fakeSendPane = path.join(tmp, 'send-pane.js');
    fs.writeFileSync(
      fakeSendPane,
      `require('fs').writeFileSync(${JSON.stringify(capturedEnvPath)}, JSON.stringify({ WEZTERM_PANE: process.env.WEZTERM_PANE ?? null }));\n`,
      'utf8'
    );

    // poll-and-notify.js は scriptsDir(=__dirname) 直下の poll-pr.js / send-pane.js を固定パスで参照するため、
    // それらをスクリプト本体と同じ一時ディレクトリに配置し、そのコピーを実行する。
    const scriptsDir = path.join(tmp, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(scriptsDir, 'poll-and-notify.js'));
    fs.copyFileSync(fakePollPr, path.join(scriptsDir, 'poll-pr.js'));
    fs.copyFileSync(fakeSendPane, path.join(scriptsDir, 'send-pane.js'));

    const r = spawnSync(process.execPath, [
      path.join(scriptsDir, 'poll-and-notify.js'),
      '1',
      '--workspace', workspace,
    ], {
      encoding: 'utf8',
      env: { ...process.env, WEZTERM_PANE: '42' },
      timeout: 10000,
    });

    assert.equal(r.status, 0, `poll-and-notify.js failed: ${r.stderr}`);
    assert.ok(fs.existsSync(capturedEnvPath), 'send-pane.js モックが呼ばれていない');
    const captured = JSON.parse(fs.readFileSync(capturedEnvPath, 'utf8'));
    assert.equal(captured.WEZTERM_PANE, null, 'WEZTERM_PANE が子プロセスに継承されてはならない');
  });
});
