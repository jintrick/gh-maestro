'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-send.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', ...env },
  });
}

// ── --help ──────────────────────────────────────────────────────────────

test('--help が usage を stdout に出して exit 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-send.js'));
  assert.equal(r.stderr, '');
});

test('-h が usage を stdout に出して exit 0', () => {
  const r = run(['-h']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-send.js'));
  assert.equal(r.stderr, '');
});

// ── 引数エラー ──────────────────────────────────────────────────────────

test('引数なしは stderr に usage を出して exit 1', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('queue-send.js'));
});

test('メッセージ不足は stderr に usage を出して exit 1', () => {
  const r = run(['worker-1']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('queue-send.js'));
});

test('空のディレクトリでも enqueue は成功する（キューが自動作成される）', () => {
  // --workspace で空のディレクトリを指定すると、queue.js がキュー構造を自動作成する。
  // このテストは .gh-maestro なしでも enqueue が成功することを確認する。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-nws-'));
  try {
    const r = run(['worker-1', 'hello', '--workspace', tmpDir]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 正常送信 ────────────────────────────────────────────────────────────

test('正常送信で messageId が stdout に出て exit 0', () => {
  withTempDir(workspace => {
    const r = run(['worker-1', 'hello world', '--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0);
    assert.equal(r.stderr, '');
  });
});

test('送信したメッセージが inbox に正しく作成される', () => {
  withTempDir(workspace => {
    const r = run(['worker-1', 'test body', '--workspace', workspace]);
    assert.equal(r.status, 0);
    const messageId = r.stdout.trim();

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', `${messageId}.json`);
    assert.ok(fs.existsSync(inboxFile));

    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.messageId, messageId);
    assert.equal(parsed.to, 'worker-1');
    assert.equal(parsed.from, 'orchestrator');
    assert.equal(parsed.body, 'test body');
    assert.equal(parsed.kind, 'instruction');
    assert.ok(parsed.createdAt);
  });
});

test('--kind でメッセージ種別を指定できる', () => {
  withTempDir(workspace => {
    const r = run(['worker-1', 'alert', '--kind', 'notification', '--workspace', workspace]);
    assert.equal(r.status, 0);
    const messageId = r.stdout.trim();

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', `${messageId}.json`);
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.kind, 'notification');
  });
});

test('--message-id で messageId を固定できる', () => {
  withTempDir(workspace => {
    const r = run(['worker-1', 'fixed', '--message-id', 'my-custom-id', '--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'my-custom-id');

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', 'my-custom-id.json');
    assert.ok(fs.existsSync(inboxFile));
  });
});

test('GH_MAESTRO_WORKER 環境変数が from に使われる', () => {
  withTempDir(workspace => {
    const r = run(['worker-1', 'from worker', '--workspace', workspace], { GH_MAESTRO_WORKER: 'test-worker' });
    assert.equal(r.status, 0);
    const messageId = r.stdout.trim();

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', `${messageId}.json`);
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.from, 'test-worker');
  });
});

test('GH_MAESTRO_WORKER がない場合 from は orchestrator', () => {
  withTempDir(workspace => {
    const r = run(['worker-1', 'from default', '--workspace', workspace]);
    assert.equal(r.status, 0);
    const messageId = r.stdout.trim();

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1', `${messageId}.json`);
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.from, 'orchestrator');
  });
});

test('workspace が .gh-maestro のないディレクトリでも enqueue は成功する（自動作成）', () => {
  withTempDir(workspace => {
    // queue.js の enqueue は必要に応じて queue/tmp, queue/inbox ディレクトリを作成するため、
    // 空のディレクトリでも enqueue は成功する
    const r = run(['worker-1', 'hello', '--workspace', workspace]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0);

    const inboxDir = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'worker-1');
    assert.ok(fs.existsSync(inboxDir), 'queue ディレクトリが自動作成される');
  });
});

// ── フラグ値不足 ───────────────────────────────────────────────────────

test('--kind を値なしで指定すると exit 1', () => {
  const r = run(['worker-1', 'hello', '--kind']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--kind'));
});

test('--workspace を値なしで指定すると exit 1', () => {
  const r = run(['worker-1', 'hello', '--workspace']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--workspace'));
});

test('--message-id を値なしで指定すると exit 1', () => {
  const r = run(['worker-1', 'hello', '--message-id']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--message-id'));
});
