'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const supervisor = require('../scripts/inbox-supervisor');
const { spawnSync } = require('../scripts/child-process');
const { weztermCli } = require('../scripts/wezterm-cli');
const paneLaunch = require('../scripts/shared/pane-launch');

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

/**
 * 最小限の .gh-maestro 環境をセットアップする。
 *
 * opts.workers を指定した場合、resume経由の配送テストがそのまま使えるよう
 * （1）orchestratorのpaneIdが未指定なら既定値を補い、
 * （2）各worker（orchestrator除く）のworktreeディレクトリを自動作成する。
 * WezTermへのテキスト注入は廃止し配送は常にresume（ペイン起動）のみを
 * 経路とするため、resumeが辿る前提条件をテストのセットアップ側で満たしておく。
 */
function setupWorkspace(dir, opts = {}) {
  const maestroDir = path.join(dir, '.gh-maestro');
  fs.mkdirSync(maestroDir, { recursive: true });

  if (opts.workers) {
    const workers = { orchestrator: { paneId: '1' }, ...opts.workers };
    fs.writeFileSync(path.join(maestroDir, 'workers.json'), JSON.stringify(workers, null, 2));
    for (const name of Object.keys(opts.workers)) {
      if (name === 'orchestrator') continue;
      fs.mkdirSync(path.join(maestroDir, 'worktrees', name), { recursive: true });
    }
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
}

/** 全モックを実実装にリセット */
/** resumeによるペイン起動が既定で成功するようにpane-launch側のモックを設定する */
function resetPaneLaunchMocks() {
  paneLaunch._setWeztermSplitPane(() => ({ status: 0, stdout: '999', stderr: '' }));
  paneLaunch._setWeztermKillPane(() => ({ status: 0, stdout: '', stderr: '' }));
  paneLaunch._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));
  paneLaunch._setSleep(() => {});
}

function resetAllMocks() {
  resetGhRepoView();
  resetGhApiComments();
  resetWeztermMocks();
  resetPaneLaunchMocks();
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

// ═══════════════════════════════════════════════════════════════════════════
// deliverMessage
// ═══════════════════════════════════════════════════════════════════════════
//
// 稼働中ペインへのテキスト注入（send-text）による配送は廃止した（実障害:
// 2026-07-15、WezTermは起動基盤としてのみ使うという設計原則に反していた）。
// 配送は常にresume（プロセスの起動/再開）のみを経路とする。

describe('Delivery', () => {
  beforeEach(() => resetWeztermMocks());

  test('deliverMessage: ペイン生存時は稼働中とみなしpending（送信しない）', () => {
    supervisor._setWeztermListPanes(() => ({
      status: 0,
      stdout: JSON.stringify([{ pane_id: 123 }]),
      stderr: '',
    }));

    const result = supervisor.deliverMessage({
      workerName: 'w', paneId: '123', agentId: null,
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
      homedir: '/home/user', issue: '5',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'pending');
    assert.ok(result.error.includes('alive'));
  });

  test('deliverMessage: ペイン非生存時は pending', () => {
    supervisor._setWeztermListPanes(() => ({
      status: 0,
      stdout: JSON.stringify([{ pane_id: 999 }]),
      stderr: '',
    }));

    const result = supervisor.deliverMessage({
      workerName: 'w', paneId: '123', agentId: null,
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
      homedir: '/home/user', issue: '5',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'pending');
  });

  test('deliverMessage: paneId が null の場合は pending', () => {
    const result = supervisor.deliverMessage({
      workerName: 'w', paneId: null, agentId: null,
      message: { from: 'orch', body: 'hello' }, workspace: '/ws',
      homedir: '/home/user', issue: '5',
    });

    assert.equal(result.success, false);
    assert.equal(result.method, 'pending');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tryResumeAndDeliver / deliverMessage の resume 配線
// ═══════════════════════════════════════════════════════════════════════════

describe('resume配線（休止中のセッション再開系ワーカー）', () => {
  const paneLaunch = require('../scripts/shared/pane-launch');
  const { readWorkersRaw } = require('../scripts/shared/workers-registry');

  /** launchAgentInPane が split-pane に渡す argv（ログインシェルラップ済み）から元のコマンド文字列を復元する */
  function decodeLoginShellCommand(splitArgs) {
    const idx = splitArgs.indexOf('-EncodedCommand');
    if (idx !== -1 && splitArgs[idx + 1]) {
      return Buffer.from(splitArgs[idx + 1], 'base64').toString('utf16le');
    }
    // bash -lc 経由（Unix）: ラップ後の生argvがそのまま並ぶ
    return splitArgs.join(' ');
  }

  beforeEach(() => {
    resetWeztermMocks();
    paneLaunch._setWeztermSplitPane(() => ({ status: 0, stdout: '77', stderr: '' }));
    paneLaunch._setWeztermKillPane(() => ({ status: 0, stdout: '', stderr: '' }));
    paneLaunch._setWeztermSendText(() => ({ status: 0, stdout: '', stderr: '' }));
    paneLaunch._setSleep(() => {});
  });

  function setupResumeWorkspace(dir, { workerName = 'issue-7-fix', agentId = 'agy' } = {}) {
    fs.mkdirSync(path.join(dir, '.gh-maestro', 'worktrees', workerName), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify({
      orchestrator: { paneId: '1' },
      [workerName]: { paneId: '456', agentId, issue: 7 },
    }, null, 2));
  }

  test('tryResumeAndDeliver: asynchronousNotification=true（claude）は method:pending でresumeしない', () => {
    const result = supervisor.tryResumeAndDeliver({
      workerName: 'issue-7-fix', agentId: 'claude',
      message: { from: 'orch', body: 'hi' }, workspace: '/ws', homedir: '/home',
    });
    assert.equal(result.method, 'pending');
    assert.equal(result.success, false);
  });

  test('tryResumeAndDeliver: agentIdが未解決なら method:pending', () => {
    const result = supervisor.tryResumeAndDeliver({
      workerName: 'issue-7-fix', agentId: 'nonexistent-agent',
      message: { from: 'orch', body: 'hi' }, workspace: '/ws', homedir: '/home',
    });
    assert.equal(result.method, 'pending');
  });

  test('tryResumeAndDeliver: worktreeが存在しなければ resume-failed', () => {
    withTempDir((dir) => {
      // workers.json のみ用意し、worktreeディレクトリは作らない
      fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify({
        orchestrator: { paneId: '1' },
        'issue-7-fix': { paneId: '456', agentId: 'agy', issue: 7 },
      }, null, 2));

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
      assert.ok(result.error.includes('worktree'));
    });
  });

  test('tryResumeAndDeliver: agy成功時はresumeし新paneIdでworkers.jsonを更新する', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });

      let splitArgs = null;
      paneLaunch._setWeztermSplitPane((args) => {
        splitArgs = args;
        return { status: 0, stdout: '77', stderr: '' };
      });

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: '新着メッセージ本文' }, workspace: dir, homedir: '/home',
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
      assert.equal(result.newPaneId, '77');

      // 分割元は orchestrator のペイン（'1'）
      assert.ok(splitArgs.includes('1'));
      // ログインシェルでラップされたコマンド文字列に --continue とメッセージ本文が含まれる
      assert.ok(decodeLoginShellCommand(splitArgs).includes('--continue'));
      assert.ok(decodeLoginShellCommand(splitArgs).includes('新着メッセージ本文'));

      const raw = readWorkersRaw(dir);
      assert.equal(raw['issue-7-fix'].paneId, '77');
    });
  });

  test('tryResumeAndDeliver: codex（positional）も成功する', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-8-fix', agentId: 'codex' });

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-8-fix', agentId: 'codex',
        message: { from: 'orch', body: 'test' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
    });
  });

  test('tryResumeAndDeliver: reasonix（send-text-after-launch）も成功する', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-9-fix', agentId: 'reasonix' });

      const sentTexts = [];
      paneLaunch._setWeztermSendText((paneId, text) => {
        sentTexts.push(text);
        return { status: 0, stdout: '', stderr: '' };
      });

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-9-fix', agentId: 'reasonix',
        message: { from: 'orch', body: 'reasonix宛メッセージ' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, true);
      assert.ok(sentTexts.includes('reasonix宛メッセージ'));
    });
  });

  test('tryResumeAndDeliver: ペイン起動失敗時は resume-failed', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      paneLaunch._setWeztermSplitPane(() => ({ status: 1, stdout: '', stderr: 'split boom' }));

      const result = supervisor.tryResumeAndDeliver({
        workerName: 'issue-7-fix', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home',
      });
      assert.equal(result.success, false);
      assert.equal(result.method, 'resume-failed');
    });
  });

  test('deliverMessage: ペイン非生存 + session-resume系エージェントは resume を試みる', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'agy' });
      supervisor._setWeztermListPanes(() => ({ status: 0, stdout: '[]', stderr: '' }));

      const result = supervisor.deliverMessage({
        workerName: 'issue-7-fix', paneId: '456', agentId: 'agy',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home', issue: '7',
      });

      assert.equal(result.success, true);
      assert.equal(result.method, 'resume');
    });
  });

  test('deliverMessage: ペイン非生存 + claude は従来通りpending（resumeしない）', () => {
    withTempDir((dir) => {
      setupResumeWorkspace(dir, { workerName: 'issue-7-fix', agentId: 'claude' });
      supervisor._setWeztermListPanes(() => ({ status: 0, stdout: '[]', stderr: '' }));

      let splitCalled = false;
      paneLaunch._setWeztermSplitPane(() => { splitCalled = true; return { status: 0, stdout: '77', stderr: '' }; });

      const result = supervisor.deliverMessage({
        workerName: 'issue-7-fix', paneId: '456', agentId: 'claude',
        message: { from: 'orch', body: 'hi' }, workspace: dir, homedir: '/home', issue: '7',
      });

      assert.equal(result.success, false);
      assert.equal(result.method, 'pending');
      assert.equal(splitCalled, false, 'claude系ではsplit-paneを呼ばない');
    });
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
    // ペインは非生存（休止中）とし、resume経由で配送させる
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
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
    // ペインは非生存（休止中）とし、resume経由で配送させる
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
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
    // ペイン非生存 → resumeを試みるが、ペイン起動自体が失敗する
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));
    paneLaunch._setWeztermSplitPane(() => ({ status: 1, stdout: '', stderr: 'split boom' }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
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
    // ペインは非生存（休止中）とし、resume経由での再試行を成功させる
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
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

  test('pending 再試行: lastBody が空の場合に _ghApiComments から本文を再取得して配送する', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    // 新着コメントスキャンは空
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 350,
        created_at: '2024-06-01T15:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> re-fetched body content',
      },
    ]));
    // ペインは非生存（休止中）とし、resume経由での再試行を成功させる
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
        },
        cursors: {
          'issue-5-fix': {
            since: '2024-06-01T12:00:00Z',
            seenIds: [350],
            deliveredIds: [],
            pendingDeliveries: {
              '350': {
                retries: 1,
                lastAttempt: new Date(Date.now() - 20000).toISOString(),
                lastError: 'pane not alive',
                lastFrom: 'orchestrator',
                lastBody: '',  // ★ 空 — 再取得パスをテスト
              },
            },
          },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      // 再試行が行われ、本文を再取得して配送成功する
      assert.ok(r.lines.some(l => l.startsWith('RETRYING:issue-5-fix:350')),
        `RETRYING not found in: ${r.lines.join('\n')}`);
      assert.ok(r.lines.some(l => l === 'DELIVERED:issue-5-fix:350'),
        `DELIVERED not found in: ${r.lines.join('\n')}`);

      const state = supervisor.readCursor(dir, 'issue-5-fix');
      assert.ok(state.deliveredIds.includes(350));
      assert.equal(state.pendingDeliveries['350'], undefined);
      // 再取得された本文が pending エントリに保存されている
      // （pending は削除済みのため、lastBody の検証は不要）
    });
  });

  test('pending が MAX_RETRIES 超過で再試行されない', () => {
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
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
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
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
          'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 },
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
          'no-issue-worker': { paneId: '123', agentId: 'agy', issue: null },
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
    // どちらのペインも非生存（休止中）とし、resume経由で配送させる
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '111', agentId: 'agy', issue: 5 },
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

  test('claude系（asynchronousNotification:true）はスキャン対象外— 検出もペイン起動も行わない', () => {
    // 実障害（2026-07-15）: claude系workerは自己ポーリングが唯一の正規配送経路のはずが、
    // deliverMessage()がworker種別を見ずペイン生存時に無条件でWezTerm送信していた。
    // フォールバックのつもりが無差別送信になっていたため、そもそもscanの段階で除外する。
    supervisor._setGhRepoView(mockGhRepoView('test/repo'));
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 900, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg',
      },
    ]));
    let splitPaneCalled = false;
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([{ pane_id: 456 }]), stderr: '',
    }));
    paneLaunch._setWeztermSplitPane(() => { splitPaneCalled = true; return { status: 0, stdout: '999', stderr: '' }; });

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: {
          'issue-5-fix': { paneId: '456', agentId: 'claude', issue: 5 },
        },
      });

      const r = supervisor.main(['--workspace', dir]);
      assert.equal(r.code, 0);
      r.runOnce();

      assert.ok(!r.lines.some(l => l.startsWith('DETECTED:issue-5-fix:')), 'claude系workerは検出対象に含まれない');
      assert.equal(splitPaneCalled, false, 'claude系workerに対してWezTermペインを起動してはならない');

      const lastLine = r.lines[r.lines.length - 1];
      // workers.size（読み込まれたworker数）は1のままだが、検出数（totalDetected）は0のまま
      assert.ok(lastLine.includes('SCAN_END:1:0'), `claude系はskipされ検出0件になるはず: ${lastLine}`);
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
    // ペインは非生存（休止中）とし、resume経由で配送させる
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    // 1回目の run: コメント 700 を配送
    supervisor._setGhApiComments(mockGhApiComments([
      {
        id: 700, created_at: '2024-06-01T12:00:00Z',
        body: '<!-- gh-maestro {"v":1,"to":"issue-5-fix","from":"orchestrator"} -->\n> msg',
      },
    ]));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 } },
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
        workers: { 'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 } },
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
    // 再試行時もペインは非生存（休止中）のままとし、resume経由で配送させる
    supervisor._setWeztermListPanes(() => ({
      status: 0, stdout: JSON.stringify([]), stderr: '',
    }));

    withTempDir((dir) => {
      setupWorkspace(dir, {
        workers: { 'issue-5-fix': { paneId: '456', agentId: 'agy', issue: 5 } },
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

// ═══════════════════════════════════════════════════════════════════════════
// CLI integration: 実プロセス起動での動作確認
// ═══════════════════════════════════════════════════════════════════════════

const { spawnSync: realSpawnSync } = require('child_process');
const { registerProcess: plcRegister, unregisterProcess: plcUnregister } = require('../scripts/process-lifecycle');

const SUPERVISOR_SCRIPT = path.join(__dirname, '..', 'scripts', 'inbox-supervisor.js');

/** ヘルパー: inbox-supervisor.js を子プロセスとして起動 */
function runSupervisor(args, cwd) {
  return realSpawnSync(process.execPath, [SUPERVISOR_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('CLI integration (subprocess)', () => {
  test('--help は Usage を表示して exit 0', () => {
    withTempDir((dir) => {
      const r = runSupervisor(['--help'], dir);
      assert.equal(r.status, 0, `exit 0, got ${r.status}, stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes('Usage'), `stdout should include Usage: ${r.stdout}`);
      assert.ok(r.stdout.includes('inbox-supervisor.js'));
    });
  });

  test('-h も同様に exit 0', () => {
    withTempDir((dir) => {
      const r = runSupervisor(['-h'], dir);
      assert.equal(r.status, 0, `exit 0, got ${r.status}`);
      assert.ok(r.stdout.includes('Usage'));
    });
  });

  test('--workspace 値欠落で exit 1', () => {
    withTempDir((dir) => {
      const r = runSupervisor(['--workspace'], dir);
      assert.equal(r.status, 1, `exit 1, got ${r.status}`);
      assert.ok(r.stderr.includes('フラグには値が必要'), `stderr: ${r.stderr}`);
    });
  });

  test('--workspace 未指定で workspace 外から実行すると exit 1', () => {
    withTempDir((dir) => {
      // dir には .gh-maestro がなく、GH_MAESTRO_WORKSPACE env も無い
      // → resolveWorkspace が CWD 上空探索でも見つけられず null を返す
      const r = runSupervisor(['--once'], dir);
      assert.equal(r.status, 1, `exit 1, got ${r.status}, stderr: ${r.stderr}`);
      assert.ok(
        r.stderr.includes('ワークスペースを解決') || r.stderr.includes('リポジトリを解決'),
        `stderr should mention failure: ${r.stderr}`
      );
    });
  });

  test('重複起動を検出して拒否する（既存プロセスがPID registryに登録されている場合）', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      // 自プロセスを inbox-supervisor.js として PID registry に登録
      plcRegister(dir, { script: 'inbox-supervisor.js', workerName: null });

      try {
        const r = runSupervisor(['--once', '--workspace', dir], dir);
        assert.equal(r.status, 1, `exit 1, got ${r.status}, stderr: ${r.stderr}`);
        assert.ok(r.stderr.includes('重複起動'), `stderr should mention 重複起動: ${r.stderr}`);
      } finally {
        plcUnregister(dir);
      }
    });
  });

  test('--force 指定時は重複起動チェックをバイパスする', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });
      plcRegister(dir, { script: 'inbox-supervisor.js', workerName: null });

      try {
        const r = runSupervisor(['--once', '--force', '--workspace', dir], dir);
        assert.notEqual(r.status, 0, `should exit non-zero (gh failure), got ${r.status}`);
        assert.ok(!r.stderr.includes('重複起動'),
          `stderr should NOT mention 重複起動: ${r.stderr}`);
      } finally {
        plcUnregister(dir);
      }
    });
  });

  test('PID registry に該当エントリが無ければ正常起動を試みる', () => {
    withTempDir((dir) => {
      const maestroDir = path.join(dir, '.gh-maestro');
      fs.mkdirSync(maestroDir, { recursive: true });

      const r = runSupervisor(['--once', '--workspace', dir], dir);
      assert.notEqual(r.status, 0, `should exit non-zero (no git repo), got ${r.status}`);
      assert.ok(!r.stderr.includes('重複起動'),
        `stderr should NOT mention 重複起動: ${r.stderr}`);
      assert.ok(r.stderr.includes('リポジトリを解決'),
        `stderr should mention repo resolution failure: ${r.stderr}`);
    });
  });
});
