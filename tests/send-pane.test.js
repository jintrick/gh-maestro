'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'send-pane.js');

// All tests use GH_MAESTRO_DISABLE_LAZY_POLLER=1 to prevent spawning real poller processes.
function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', ...env },
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

// ── CLI argument validation ────────────────────────────────────────────────

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

test('--help が usage を stdout に出して exit 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('send-pane.js'));
  assert.equal(r.stderr, '');
});

test('-h が usage を stdout に出して exit 0', () => {
  const r = run(['-h']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('send-pane.js'));
  assert.equal(r.stderr, '');
});

// ── enqueue (Phase 4) ──────────────────────────────────────────────────────

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

test('orchestrator への送信も inbox に正しく作成される', () => {
  withTempDir(workspace => {
    const r = run(['orchestrator', 'hello orchestrator', '--workspace', workspace]);
    assert.equal(r.status, 0);
    const messageId = r.stdout.trim();

    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'orchestrator', `${messageId}.json`);
    assert.ok(fs.existsSync(inboxFile));

    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.to, 'orchestrator');
    assert.equal(parsed.from, 'orchestrator');
  });
});

// ── sender prefix (backward compatible) ────────────────────────────────────

test('orchestratorからの送信にはプレフィックス "orchestratorです。" が付く', () => {
  withTempDir(workspace => {
    const ghMaestroDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghMaestroDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghMaestroDir, 'workers.json'),
      JSON.stringify({ orchestrator: '1', 'issue-1-implement': '2' }),
      'utf8'
    );

    // WEZTERM_PANE=1 → 自分はorchestratorとして認識される
    const r = run(['issue-1-implement', 'test message', '--workspace', workspace], {
      WEZTERM_PANE: '1',
    });
    assert.equal(r.status, 0);

    const messageId = r.stdout.trim();
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'issue-1-implement', `${messageId}.json`);
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.match(parsed.body, /^orchestratorです。/);
    assert.ok(parsed.body.includes('test message'));
  });
});

test('workerからの送信にはプレフィックス "XXX担当workerです。" が付く', () => {
  withTempDir(workspace => {
    const ghMaestroDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghMaestroDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghMaestroDir, 'workers.json'),
      JSON.stringify({ orchestrator: '0', 'issue-1-implement': '1' }),
      'utf8'
    );

    // WEZTERM_PANE=1 → 自分はissue-1-implement workerとして認識される
    const r = run(['orchestrator', 'report from worker', '--workspace', workspace], {
      WEZTERM_PANE: '1',
    });
    assert.equal(r.status, 0);

    const messageId = r.stdout.trim();
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'orchestrator', `${messageId}.json`);
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.match(parsed.body, /issue-1-implement担当workerです。/);
    assert.ok(parsed.body.includes('report from worker'));
    assert.equal(parsed.from, 'issue-1-implement');
  });
});

// ── workers.json が存在する場合の recipient 解決 ────────────────────────

test('workers.json が存在する場合でも enqueue 先は名前そのまま（pane-id解決は不要）', () => {
  withTempDir(workspace => {
    const ghMaestroDir = path.join(workspace, '.gh-maestro');
    fs.mkdirSync(ghMaestroDir, { recursive: true });
    fs.writeFileSync(
      path.join(ghMaestroDir, 'workers.json'),
      JSON.stringify({ orchestrator: '42', 'issue-1-implement': '99' }),
      'utf8'
    );

    const r = run(['issue-1-implement', 'hello', '--workspace', workspace], {
      WEZTERM_PANE: '99',
    });
    assert.equal(r.status, 0);
    // Usage エラーにならない（引数は正しい）
    assert.ok(!r.stderr.includes('Usage'), `予期しないUsageエラー: ${r.stderr}`);

    // enqueue 先は "issue-1-implement"（pane-idではなく名前のまま）
    const messageId = r.stdout.trim();
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'issue-1-implement', `${messageId}.json`);
    assert.ok(fs.existsSync(inboxFile));
  });
});

// ── workspace 解決 ─────────────────────────────────────────────────────────

test('空のディレクトリでも enqueue は成功する（キューが自動作成される）', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-nws-'));
  try {
    const r = run(['worker-1', 'hello', '--workspace', tmpDir]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('--workspace なしで GH_MAESTRO_WORKSPACE env 経由で解決できる', () => {
  withTempDir(workspace => {
    const r = spawnSync(process.execPath, [SCRIPT, 'worker-1', 'hello'], {
      encoding: 'utf8',
      env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', GH_MAESTRO_WORKSPACE: workspace },
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0);
  });
});

// ── フラグ値不足 ───────────────────────────────────────────────────────────

test('--workspace を値なしで指定すると exit 1', () => {
  const r = run(['worker-1', 'hello', '--workspace']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--workspace'));
});

// ── GH_MAESTRO_WORKER env が from に使われる ─────────────────────────────

test('GH_MAESTRO_WORKER 環境変数が from に使われる（sender検出より優先）', () => {
  withTempDir(workspace => {
    const r = run(['orchestrator', 'from worker env', '--workspace', workspace], {
      GH_MAESTRO_WORKER: 'test-worker',
    });
    assert.equal(r.status, 0);
    const messageId = r.stdout.trim();
    const inboxFile = path.join(workspace, '.gh-maestro', 'queue', 'inbox', 'orchestrator', `${messageId}.json`);
    const parsed = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
    assert.equal(parsed.from, 'test-worker');
  });
});

// ── Phase 4: .gh-maestro/messages 非依存の確認 ─────────────────────────────

test('送信後 .gh-maestro/messages/ にファイルが作られない（enqueue に移行済み）', () => {
  withTempDir(workspace => {
    const r = run(['worker-1', 'test message', '--workspace', workspace]);
    assert.equal(r.status, 0);

    const messagesDir = path.join(workspace, '.gh-maestro', 'messages');
    assert.ok(!fs.existsSync(messagesDir), '.gh-maestro/messages/ は作られるべきではない');
  });
});
