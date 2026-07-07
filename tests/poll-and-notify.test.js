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

test('poll-pr.js の stdout 出力を orchestrator の inbox に enqueue する', () => {
  withTempDir(tmp => {
    const workspace = path.join(tmp, 'project');
    fs.mkdirSync(workspace, { recursive: true });

    // poll-pr.js の代わりに2行出力してすぐ終了するモックを用意する
    const fakePollPr = path.join(tmp, 'poll-pr.js');
    const fakePollPrLines = [
      "console.log('PR_DETECTED:480');",
      "console.log('REVIEW_MANAGER_STARTED:480');",
      ""
    ];
    fs.writeFileSync(fakePollPr, fakePollPrLines.join('\n'), 'utf8');

    // poll-and-notify.js は scriptsDir(=__dirname) 直下の poll-pr.js を固定パスで参照するため、
    // それらをスクリプト本体と同じ一時ディレクトリに配置し、そのコピーを実行する。
    const scriptsDir = path.join(tmp, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    // poll-and-notify.js が require('./queue') できるように queue.js もコピー
    const sharedDir = path.join(tmp, 'scripts', 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    // queue.js の依存もコピー
    const origScriptsDir = path.join(__dirname, '..', 'scripts');
    fs.copyFileSync(SCRIPT, path.join(scriptsDir, 'poll-and-notify.js'));
    fs.copyFileSync(fakePollPr, path.join(scriptsDir, 'poll-pr.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'child-process.js'), path.join(scriptsDir, 'child-process.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'queue.js'), path.join(scriptsDir, 'queue.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'queue-poller.js'), path.join(scriptsDir, 'queue-poller.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'shared', 'workspace.js'), path.join(sharedDir, 'workspace.js'));

    const r = spawnSync(process.execPath, [
      path.join(scriptsDir, 'poll-and-notify.js'),
      '1',
      '--workspace', workspace,
      '--from', 'test-worker',
    ], {
      encoding: 'utf8',
      env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1' },
      timeout: 10000,
    });

    assert.equal(r.status, 0, `poll-and-notify.js failed: ${r.stderr}`);

    // orchestrator の inbox にメッセージが enqueue されていることを確認
    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'orchestrator');
    assert.ok(fs.existsSync(inboxDir), 'orchestrator の inbox が作成されるべき');

    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 2, '2行の出力がそれぞれ enqueue されるべき');

    // 内容検証
    for (const file of files) {
      const msg = JSON.parse(fs.readFileSync(path.join(inboxDir, file), 'utf8'));
      assert.equal(msg.to, 'orchestrator');
      assert.equal(msg.from, 'test-worker');
      assert.equal(msg.kind, 'notification');
      assert.ok(msg.body.includes('REVIEW') || msg.body.includes('PR_DETECTED'));
    }
  });
});

test('--from を省略した場合 GH_MAESTRO_WORKER env またはデフォルト "coder" が使われる', () => {
  withTempDir(tmp => {
    const workspace = path.join(tmp, 'project');
    fs.mkdirSync(workspace, { recursive: true });

    const fakePollPr = path.join(tmp, 'poll-pr.js');
    fs.writeFileSync(fakePollPr, ["console.log('PR_DETECTED:123');", ""].join('\n'), 'utf8');

    const scriptsDir = path.join(tmp, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const sharedDir = path.join(tmp, 'scripts', 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    const origScriptsDir = path.join(__dirname, '..', 'scripts');
    fs.copyFileSync(SCRIPT, path.join(scriptsDir, 'poll-and-notify.js'));
    fs.copyFileSync(fakePollPr, path.join(scriptsDir, 'poll-pr.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'child-process.js'), path.join(scriptsDir, 'child-process.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'queue.js'), path.join(scriptsDir, 'queue.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'queue-poller.js'), path.join(scriptsDir, 'queue-poller.js'));
    fs.copyFileSync(path.join(origScriptsDir, 'shared', 'workspace.js'), path.join(sharedDir, 'workspace.js'));

    const r = spawnSync(process.execPath, [
      path.join(scriptsDir, 'poll-and-notify.js'),
      '1',
      '--workspace', workspace,
    ], {
      encoding: 'utf8',
      env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', GH_MAESTRO_WORKER: 'env-worker' },
      timeout: 10000,
    });

    assert.equal(r.status, 0, `poll-and-notify.js failed: ${r.stderr}`);

    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'orchestrator');
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const msg = JSON.parse(fs.readFileSync(path.join(inboxDir, files[0]), 'utf8'));
    assert.equal(msg.from, 'env-worker', 'GH_MAESTRO_WORKER env が from に使われるべき');
    assert.match(msg.body, /PR_DETECTED:123/);
  });
});
