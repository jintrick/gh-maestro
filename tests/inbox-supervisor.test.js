'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const supervisor = require('../scripts/inbox-supervisor');
const { spawnSync } = require('../scripts/child-process');
const { weztermCli } = require('../scripts/wezterm-cli');

// ── テストヘルパー ────────────────────────────────────────────────────────

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** 最小限の .gh-maestro 環境をセットアップ */
function setupWorkspace(dir, opts = {}) {
  const maestroDir = path.join(dir, '.gh-maestro');
  fs.mkdirSync(maestroDir, { recursive: true });

  if (opts.workers) {
    fs.writeFileSync(path.join(maestroDir, 'workers.json'), JSON.stringify(opts.workers, null, 2));
  }

  if (opts.cursors) {
    const cursorsDir = path.join(maestroDir, 'inbox-supervisor', 'cursors');
    fs.mkdirSync(cursorsDir, { recursive: true });
    for (const [name, state] of Object.entries(opts.cursors)) {
      fs.writeFileSync(path.join(cursorsDir, `${name}.json`), JSON.stringify(state, null, 2));
    }
  }

  return maestroDir;
}

/** 成功 gh repo view のモック */
function mockGhRepoView(repo) {
  return () => ({
    status: 0,
    stdout: repo + '\n',
    stderr: '',
  });
}

/** 成功 gh api comments のモック */
function mockGhApiComments(comments) {
  return () => ({
    status: 0,
    stdout: JSON.stringify(comments),
    stderr: '',
  });
}

/** gh api comments の実実装にリセット */
function resetGhApiComments() {
  supervisor._setGhApiComments((repo, issue, since, opts = {}) => {
    const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp'];
    if (since) args.push('-f', `since=${since}`);
    args.push('-f', 'per_page=100');
    return spawnSync('gh', args, { encoding: 'utf8', timeout: 30000, ...opts });
  });
}

/** gh repo view の実実装にリセット */
function resetGhRepoView() {
  supervisor._setGhRepoView((opts = {}) => {
    return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
      { encoding: 'utf8', timeout: 30000, ...opts });
  });
}

/** wezterm mocks の実実装にリセット */
function resetWeztermMocks() {
  supervisor._setWeztermListPanes((opts) => weztermCli('cli', 'list', '--format', 'json'));
  supervisor._setWeztermSendText((paneId, text, opts) =>
    weztermCli('cli', 'send-text', '--pane-id', String(paneId), '--no-paste', text));
}

/** 全モックを実実装にリセット */
function resetAllMocks() {
  resetGhRepoView();
  resetGhApiComments();
  resetWeztermMocks();
}

// ═══════════════════════════════════════════════════════════════════════════
// --help / usage
// ═══════════════════════════════════════════════════════════════════════════

describe('CLI usage', () => {
  test('--help が usage を返して code 0', () => {
    const r = supervisor.main(['--help']);
    assert.equal(r.code, 0);
    assert.ok(r.lines.join('\n').includes('inbox-supervisor.js'));
    assert.equal(r.errLines.length, 0);
    assert.equal(r.runOnce, null);
  });

  test('-h が usage を返して code 0', () => {
    const r = supervisor.main(['-h']);
    assert.equal(r.code, 0);
    assert.ok(r.lines.join('\n').includes('inbox-supervisor.js'));
    assert.equal(r.runOnce, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 引数エラー
// ═══════════════════════════════════════════════════════════════════════════

describe('CLI argument validation', () => {
  test('未知の引数で code 1', () => {
    const r = withTempDir((dir) => {
      setupWorkspace(dir);
      return supervisor.main(['--workspace', dir, '--bogus']);
    });
    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('未知の引数')));
    assert.equal(r.runOnce, null);
  });

  test('--workspace 値欠落で code 1', () => {
    const r = supervisor.main(['--workspace']);
    assert.equal(r.code, 1);
    assert.equal(r.runOnce, null);
  });

  test('存在しないワークスペースパスで code 1', () => {
    // 実在しないパスを指定した場合、CWD フォールバックも効かない（/nonexistent/... 配下に CWD は無い）
    const r = supervisor.main(['--workspace', '/nonexistent/path/12345']);
    assert.equal(r.code, 1);
    assert.equal(r.runOnce, null);
  });

  test('リポジトリ解決失敗で code 1', () => {
    supervisor._setGhRepoView(() => ({
      status: 1,
      stdout: '',
      stderr: 'not a git repository',
    }));

    const r = withTempDir((dir) => {
      setupWorkspace(dir);
      return supervisor.main(['--workspace', dir]);
    });

    assert.equal(r.code, 1);
    assert.ok(r.errLines.some(l => l.includes('リポジトリ')));

    resetGhRepoView();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 状態管理: readCursor / writeCursor
// ═══════════════════════════════════════════════════════════════════════════

describe('Cursor state management', () => {
  test('readCursor: ファイルが無い場合は初期状態を返す', () => {
    withTempDir((dir) => {
      setupWorkspace(dir);
      const state = supervisor.readCursor(dir, 'test-worker');
      assert.equal(state.since, null);
      assert.deepEqual(state.seenIds, []);
      assert.deepEqual(state.deliveredIds, []);
      assert.deepEqual(state.pendingDeliveries, {});
    });
  });

  test('readCursor: 既存のカーソルを読み込む', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        cursors: {
          'test-worker': {
            since: '2024-01-01T00:00:00Z',
            seenIds: [1, 2, 3],
            deliveredIds: [1, 2],
            pendingDeliveries: { '3': { retries: 1, lastError: 'timeout' } },
          },
        },
      });

      const state = supervisor.readCursor(dir, 'test-worker');
      assert.equal(state.since, '2024-01-01T00:00:00Z');
      assert.deepEqual(state.seenIds, [1, 2, 3]);
      assert.deepEqual(state.deliveredIds, [1, 2]);
      assert.deepEqual(state.pendingDeliveries, { '3': { retries: 1, lastError: 'timeout' } });
    });
  });

  test('readCursor: 壊れたJSONは初期状態を返す', () => {
    withTempDir((dir) => {
      const cursorsDir = path.join(dir, '.gh-maestro', 'inbox-supervisor', 'cursors');
      fs.mkdirSync(cursorsDir, { recursive: true });
      fs.writeFileSync(path.join(cursorsDir, 'bad.json'), '{broken json');

      const state = supervisor.readCursor(dir, 'bad');
      assert.equal(state.since, null);
      assert.deepEqual(state.seenIds, []);
    });
  });

  test('writeCursor → readCursor がラウンドトリップする', () => {
    withTempDir((dir) => {
      setupWorkspace(dir);

      const state = {
        since: '2024-06-01T12:00:00Z',
        seenIds: [10, 20, 30],
        deliveredIds: [10, 20],
        pendingDeliveries: { '30': { retries: 2, lastError: 'send-text failed', lastFrom: 'orch', lastBody: 'hello' } },
      };

      supervisor.writeCursor(dir, 'roundtrip', state);
      const loaded = supervisor.readCursor(dir, 'roundtrip');

      assert.equal(loaded.since, state.since);
      assert.deepEqual(loaded.seenIds, state.seenIds);
      assert.deepEqual(loaded.deliveredIds, state.deliveredIds);
      assert.deepEqual(loaded.pendingDeliveries, state.pendingDeliveries);
    });
  });

  test('writeCursor: seenIds/deliveredIds が MAX_SEEN_IDS を超えたら切り詰める', () => {
    withTempDir((dir) => {
      setupWorkspace(dir);

      const ids = Array.from({ length: 250 }, (_, i) => i + 1);
      const state = {
        since: '2024-01-01T00:00:00Z',
        seenIds: ids,
        deliveredIds: ids,
        pendingDeliveries: {},
      };

      supervisor.writeCursor(dir, 'trim-test', state);
      const loaded = supervisor.readCursor(dir, 'trim-test');

      assert.equal(loaded.seenIds.length, 200);
      assert.equal(loaded.seenIds[0], 51);
      assert.equal(loaded.deliveredIds.length, 200);
    });
  });

  test('cursorPath / stateDir が正しいパスを返す', () => {
    const p = supervisor.cursorPath('/ws', 'my-worker');
    assert.ok(p.includes('.gh-maestro'));
    assert.ok(p.includes('inbox-supervisor'));
    assert.ok(p.includes('cursors'));
    assert.ok(p.endsWith('my-worker.json'));

    const s = supervisor.stateDir('/ws');
    assert.ok(s.endsWith(path.join('.gh-maestro', 'inbox-supervisor')));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// loadWorkers
// ═══════════════════════════════════════════════════════════════════════════

describe('loadWorkers', () => {
  test('workers.json が無い場合は空 Map を返す', () => {
    withTempDir((dir) => {
      fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
      const workers = supervisor.loadWorkers(dir);
      assert.equal(workers.size, 0);
    });
  });

  test('ワーカーを正しく読み込む（orchestrator 除外）', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          orchestrator: { paneId: 'p1', agentId: null, issue: null },
          'issue-5-fix': { paneId: 'p2', agentId: 'claude', issue: 5 },
          'issue-8-add': { paneId: 'p3', agentId: 'agy', issue: 8 },
        },
      });

      const workers = supervisor.loadWorkers(dir);
      assert.equal(workers.size, 2);
      assert.equal(workers.get('issue-5-fix').paneId, 'p2');
      assert.equal(workers.get('issue-5-fix').agentId, 'claude');
      assert.equal(workers.get('issue-5-fix').issue, 5);
      assert.equal(workers.get('issue-8-add').paneId, 'p3');
    });
  });

  test('旧形式（pane_id文字列）の後方互換', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'old-worker': 'pane-123' },
      });

      const workers = supervisor.loadWorkers(dir);
      assert.equal(workers.size, 1);
      assert.equal(workers.get('old-worker').paneId, 'pane-123');
      assert.equal(workers.get('old-worker').agentId, null);
      assert.equal(workers.get('old-worker').issue, null);
    });
  });

  test('壊れた workers.json / 配列は空 Map を返す', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });
      fs.writeFileSync(path.join(maestroDir, 'workers.json'), '{broken');
      assert.equal(supervisor.loadWorkers(dir).size, 0);
    });

    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });
      fs.writeFileSync(path.join(maestroDir, 'workers.json'), '[]');
      assert.equal(supervisor.loadWorkers(dir).size, 0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// isPaneAlive
// ═══════════════════════════════════════════════════════════════════════════

describe('isPaneAlive', () => {
  beforeEach(() => resetWeztermMocks());

  test('生存ペインは true、非存在ペインは false', () => {
    supervisor._setWeztermListPanes(() => ({
      status: 0,
      stdout: JSON.stringify([{ pane_id: 123 }, { pane_id: 456 }]),
      stderr: '',
    }));

    assert.equal(supervisor.isPaneAlive('123'), true);
    assert.equal(supervisor.isPaneAlive('456'), true);
    assert.equal(supervisor.isPaneAlive('789'), false);
  });

  test('wezterm 失敗時は false（fail-closed）', () => {
    supervisor._setWeztermListPanes(() => ({
      status: 1,
      stdout: '',
      stderr: 'connection refused',
    }));

    assert.equal(supervisor.isPaneAlive('123'), false);
  });

  test('paneId が null/空文字なら false', () => {
    assert.equal(supervisor.isPaneAlive(null), false);
    assert.equal(supervisor.isPaneAlive(''), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatMessageForAgent
// ═══════════════════════════════════════════════════════════════════════════

describe('formatMessageForAgent', () => {
  test('メッセージを整形する', () => {
    const text = supervisor.formatMessageForAgent({
      workerName: 'issue-5-fix',
      message: { from: 'orchestrator', body: '修正をお願いします。' },
    });

    assert.ok(text.includes('[gh-maestro inbox]'));
    assert.ok(text.includes('orchestrator'));
    assert.ok(text.includes('issue-5-fix'));
    assert.ok(text.includes('修正をお願いします。'));
    assert.ok(text.includes('msg-send.js'));
  });

  test('body が空でも動作する', () => {
    const text = supervisor.formatMessageForAgent({
      workerName: 'w',
      message: { from: 'orch', body: '' },
    });
    assert.ok(text.includes('[gh-maestro inbox]'));
  });

  test('\\r\\n 改行対応（inbox-adapter-crlf-handling ルール準拠）', () => {
    const text = supervisor.formatMessageForAgent({
      workerName: 'w',
      message: { from: 'orch', body: 'line1\r\nline2\r\nline3' },
    });
    assert.ok(text.includes('line1'));
    assert.ok(text.includes('line2'));
    assert.ok(text.includes('line3'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deliverToRunningAgent / deliverMessage
// ═══════════════════════════════════════════════════════════════════════════

describe('Delivery', () => {
  beforeEach(() => resetWeztermMocks());

  test('deliverToRunningAgent: 成功時は success:true', () => {
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    const result = supervisor.deliverToRunningAgent({
      paneId: '123',
      workerName: 'issue-5-fix',
      message: { from: 'orch', body: 'hello' },
    });

    assert.equal(result.success, true);
    assert.equal(result.method, 'send-text');
  });

  test('deliverToRunningAgent: wezterm 失敗時は success:false', () => {
    supervisor._setWeztermSendText(() => ({
      status: 1, stdout: '', stderr: 'pane not found',
    }));

    const result = supervisor.deliverToRunningAgent({
      paneId: '999',
      workerName: 'w',
      message: { from: 'orch', body: 'hello' },
    });

    assert.equal(result.success, false);
    assert.ok(result.error.includes('pane not found'));
  });

  test('deliverMessage: ペイン生存時は send-text を試みる', () => {
    supervisor._setWeztermListPanes(() => ({
      status: 0,
      stdout: JSON.stringify([{ pane_id: 123 }]),
      stderr: '',
    }));
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    const result = supervisor.deliverMessage({
      workerName: 'w', paneId: '123', agentId: 'claude',
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
    });

    assert.equal(result.success, true);
    assert.equal(result.method, 'send-text');
  });

  test('deliverMessage: ペイン非生存時は pending', () => {
    supervisor._setWeztermListPanes(() => ({
      status: 0,
      stdout: JSON.stringify([{ pane_id: 999 }]),
      stderr: '',
    }));

    const result = supervisor.deliverMessage({
      workerName: 'w', paneId: '123', agentId: 'claude',
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'pending');
  });

  test('deliverMessage: paneId が null の場合は pending', () => {
    const result = supervisor.deliverMessage({
      workerName: 'w', paneId: null, agentId: 'claude',
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// shouldRetry
// ═══════════════════════════════════════════════════════════════════════════

describe('shouldRetry', () => {
  test('初回（retries=0）は常に true', () => {
    assert.equal(supervisor.shouldRetry({ retries: 0 }, Date.now()), true);
  });

  test('MAX_RETRIES（5）以上なら false', () => {
    assert.equal(supervisor.shouldRetry({ retries: 5 }, Date.now()), false);
    assert.equal(supervisor.shouldRetry({ retries: 10 }, Date.now()), false);
  });

  test('バックオフ期間内は false', () => {
    const now = Date.now();
    assert.equal(supervisor.shouldRetry({ retries: 2, lastAttempt: new Date(now).toISOString() }, now), false);
  });

  test('バックオフ期間後は true', () => {
    const now = Date.now();
    // retries=1 → delay = 10s
    assert.equal(supervisor.shouldRetry(
      { retries: 1, lastAttempt: new Date(now - 15000).toISOString() }, now), true);
  });

  test('lastAttempt が無効なら true', () => {
    assert.equal(supervisor.shouldRetry({ retries: 2 }, Date.now()), true);
    assert.equal(supervisor.shouldRetry({ retries: 2, lastAttempt: 'invalid' }, Date.now()), true);
  });

  test('null/undefined は true', () => {
    assert.equal(supervisor.shouldRetry(null, Date.now()), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runOnce: スキャン・配送サイクル
// ═══════════════════════════════════════════════════════════════════════════

describe('runOnce scan and deliver cycle', () => {
  beforeEach(() => resetAllMocks());

  test('ワーカーが0件のときは SCAN_END:0:0', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));

    withTempDir((dir) => {
      setupWorkspace(dir);
      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      const lastLine = r.lines[r.lines.length - 1];
      assert.ok(lastLine.includes('SCAN_END:0:0'), `Expected SCAN_END:0:0 but got: ${lastLine}`);
    });
  });

  test('新着メッセージを検出して配送する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 100,
        created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
    ]));
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([{ pane_id: 456 }]), stderr: '',
    }));
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:100'),
        `Lines: ${r.lines.join('\n')}`);
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:100'));

      // カーソルが永続化されている
      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.seenIds.includes(100));
      assert.ok(state.deliveredIds.includes(100));
      assert.equal(state.since, '2024-06-01T12:00:00Z');
    });
  });

  test('既読メッセージは再検出しない（seenIds 重複防止）', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 100, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
      {
        id: 101, created_at: '2024-06-01T13:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test 2',
      },
    ]));
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([{ pane_id: 456 }]), stderr: '',
    }));
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [100],
            deliveredIds: [100],
            pendingDeliveries: {},
          },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l === 'DETECTED:issue-5-fix:100'), '100 should be skipped (already seen)');
      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:101'), '101 should be detected');
    });
  });

  test('配送失敗時は pendingDeliveries に記録される', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 200, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> test',
      },
    ]));
    // ペイン非生存 → 配送失敗
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:200'));
      assert.ok(r.lines.some(l => l.startsWith('DELIVERY_FAILED:issue-5-fix:200')));

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.seenIds.includes(200));
      assert.ok(!state.deliveredIds.includes(200));
      assert.ok(state.pendingDeliveries['200']);
      assert.equal(state.pendingDeliveries['200'].retries, 1);
    });
  });

  test('pending の再試行で配送成功したら deliveredIds に移動', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([{ pane_id: 456 }]), stderr: '',
    }));
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [300],
            deliveredIds: [],
            pendingDeliveries: {
              '300': {
                retries: 1,
                lastAttempt: new Date(Date.now() - 20000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: 'pending message body',
              },
            },
          },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:300')));
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:300'));

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.deliveredIds.includes(300));
      assert.equal(state.pendingDeliveries['300'], undefined);
    });
  });

  test('pending が MAX_RETRIES 超過で再試行されない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [400],
            deliveredIds: [],
            pendingDeliveries: {
              '400': {
                retries: 5,
                lastAttempt: new Date(Date.now() - 20000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: 'msg',
              },
            },
          },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:400')),
        'Should not retry when MAX_RETRIES exceeded');
    });
  });

  test('gh api エラーはスキップして続行', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(() => ({
      status: 1, stdout: '', stderr: 'rate limit exceeded',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      assert.doesNotThrow(() => r.runOnce());
      assert.ok(r.errLines.some(l => l.includes('rate limit exceeded')));
    });
  });

  test('自分宛てでないメッセージは無視する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 500, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"other-worker","from":"orchestrator"} -->\n> test',
      },
      {
        id: 501, created_at: '2024-06-01T13:00:00Z',
        body: 'no marker here',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.includes('DETECTED')), 'No messages for this worker');

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      // カーソルは全コメントの最大 created_at まで進む（非マッチも含む）
      assert.equal(state.since, '2024-06-01T13:00:00Z');
      // 自分宛てでないコメントは seenIds に入らない（カーソルが再フェッチを防ぐ）
    });
  });

  test('issue が null のワーカーはスキップ', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'no-issue-worker': { paneId: '123', agentId: 'claude', issue: null },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      const lastLine = r.lines[r.lines.length - 1];
      assert.ok(lastLine.includes('SCAN_END:1:0'), `Got: ${lastLine}`);
    });
  });

  test('複数ワーカーを独立に監視する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));

    let callCount = 0;
    supervisor._setGhApiComments(() => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 0,
          stdout: JSON.stringify([{
            id: 601, created_at: '2024-06-01T12:00:00Z',
            body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg1',
          }]),
          stderr: '',
        };
      }
      return { status: 0, stdout: JSON.stringify([]), stderr: '' };
    });
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([{ pane_id: 111 }, { pane_id: 222 }]), stderr: '',
    }));
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '111', agentId: 'claude', issue: 5 },
          'issue-8-add': { paneId: '222', agentId: 'agy', issue: 8 },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l === 'DETECTED:issue-5-fix:601'));
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:601'));

      const state5 = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state5.since, '2024-06-01T12:00:00Z');
      assert.ok(state5.seenIds.includes(601));

      const state8 = supervisor.readCursor(dir, 'issue-8-add');
      assert.equal(state8.since, null);
      assert.deepEqual(state8.seenIds, []);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 信頼性: 再起動後継続
// ═══════════════════════════════════════════════════════════════════════════

describe('Reliability: restart continuity', () => {
  beforeEach(() => resetAllMocks());

  test('再起動後もカーソルから継続できる', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([{ pane_id: 456 }]), stderr: '',
    }));
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    // 1回目の run: コメント 700 を配送
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 700, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 } },
      });

      const r1 = supervisor.main(['--workspace', dir]);
      r1.runOnce();
      assert.ok(r1.lines.some(l => l === 'DELIVERED:issue-5-fix:700'));

      // カーソルが永続化されているか確認
      const state1 = supervisor.readCursor(dir, 'issue-5-fix');
      assert.equal(state1.since, '2024-06-01T12:00:00Z');
      assert.ok(state1.deliveredIds.includes(700));
    });

    // 2回目の run（再起動シミュレーション）
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 701, created_at: '2024-06-01T13:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg2',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 } },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [700],
            deliveredIds: [700],
            pendingDeliveries: {},
          },
        },
      });

      const r2 = supervisor.main(['--workspace', dir]);
      r2.runOnce();

      // 700 は再検出されない
      const linesWith700 = r2.lines.filter(l => l.includes('700'));
      assert.equal(linesWith700.length, 0, `Should not re-detect 700: ${r2.lines.join('\n')}`);
      // 701 は新規検出
      assert.ok(r2.lines.some(l => l === 'DETECTED:issue-5-fix:701'));
    });
  });

  test('未配送メッセージが再起動後も pending に残りリトライされる', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));
    // 再試行時はペイン復活
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([{ pane_id: 456 }]), stderr: '',
    }));
    supervisor._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 } },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [800],
            deliveredIds: [],
            pendingDeliveries: {
              '800': {
                retries: 2,
                lastAttempt: new Date(Date.now() - 50000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: 'undelivered message',
              },
            },
          },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:800')));
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:800'));

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.deliveredIds.includes(800));
      assert.equal(state.pendingDeliveries['800'], undefined);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 重複配送防止
// ═══════════════════════════════════════════════════════════════════════════

describe('Duplicate delivery prevention', () => {
  beforeEach(() => resetAllMocks());

  test('配送済みメッセージは再配送しない（deliveredIds 重複防止）', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    // since が古いため既配信のコメントも再取得される
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 900, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 } },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T11:00:00Z', // コメントより前
            seenIds: [900],
            deliveredIds: [900], // 既に配送済み
            pendingDeliveries: {},
          },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      // seenIds にあるので検出自体されない
      assert.ok(!r.lines.some(l => l.includes('DETECTED')));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// エッジケース: カーソル型不一致
// ═══════════════════════════════════════════════════════════════════════════

describe('Cursor type safety', () => {
  test('since が文字列でない場合は null 扱い', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        cursors: {
          'bad-since': { since: {}, seenIds: [], deliveredIds: [], pendingDeliveries: {} },
        },
      });
      const state = supervisor.readCursor(dir, 'bad-since');
      assert.equal(state.since, null);
    });
  });

  test('seenIds/deliveredIds が配列でない場合は空配列', () => {
    withTempDir((dir) => {
      setupWorkspace(dir, {
        cursors: {
          'bad-ids': { since: null, seenIds: 'not-an-array', deliveredIds: null, pendingDeliveries: {} },
        },
      });
      const state = supervisor.readCursor(dir, 'bad-ids');
      assert.deepEqual(state.seenIds, []);
      assert.deepEqual(state.deliveredIds, []);
    });
  });
});
