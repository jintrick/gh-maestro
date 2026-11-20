'use strict';
// tests/run-council-investigation.test.js
//
// run-council-investigation.js は child-process.js の spawn / resolve-config.js /
// council-worktree.js（git 操作）に依存する。すべてモックして実プロセスを0個spawnする
//
// 明示した --workspace は環境変数より優先されるが、テスト中のworkspace
// フォールバックが実ワークスペースへ書き込まないようにこの env を無効化する。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const modulePath = require.resolve('../../scripts/run-council-investigation');

const SHA = '0123456789abcdef0123456789abcdef01234567'; // 40桁の16進数

function fakeAgentConfig(overrides = {}) {
  return {
    id: 'inv-agent',
    command: 'fake',
    promptDelivery: 'flag',
    promptFlag: '-p',
    execArgs: ['-p', '--skip-git-repo-check'],
    extraArgs: [],
    nonInteractiveTokens: [],
    ...overrides,
  };
}

/** child-process.js の spawn 戻り値のフェイク。stdout と kill を持つ EventEmitter。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  return child;
}

/**
 * 依存（child-process.js / resolve-config.js / council-worktree.js）をモックした状態で
 * run-council-investigation.js を再ロードする。
 * @returns {{ mod: object, calls: object }}
 */
function loadModule({ spawnImpl, spawnSyncImpl, councilResolve, resolveAgent, validateTokens, resolveSessionCalls = [] } = {}) {
  const spawnSyncCalls = [];
  const childProcessPath = require.resolve('../../scripts/shared/child-process');
  delete require.cache[childProcessPath];
  require.cache[childProcessPath] = {
    id: childProcessPath,
    filename: childProcessPath,
    loaded: true,
    exports: {
      spawn: spawnImpl || (() => { throw new Error('spawn must be injected'); }),
      spawnSync: (cmd, args, opts) => {
        spawnSyncCalls.push({ cmd, args, opts });
        if (spawnSyncImpl) return spawnSyncImpl(cmd, args, opts);
        throw new Error('spawnSync should not be called in this test');
      },
      execSync: () => '',
    },
  };

  const resolveConfigPath = require.resolve('../../scripts/shared/resolve-config');
  delete require.cache[resolveConfigPath];
  require.cache[resolveConfigPath] = {
    id: resolveConfigPath,
    filename: resolveConfigPath,
    loaded: true,
    exports: {
      resolveAgentConfig: resolveAgent || ((id) => (id === 'inv-agent' ? fakeAgentConfig() : null)),
      resolveCouncilConfig: councilResolve || (() => ({ groups: { default: { agents: ['inv-agent'] } }, investigationAgent: 'inv-agent' })),
      validateNonInteractiveTokens: validateTokens || (() => ({ valid: true, missing: [] })),
    },
  };

  const cwtPath = require.resolve('../../scripts/shared/council-worktree');
  delete require.cache[cwtPath];
  require.cache[cwtPath] = {
    id: cwtPath,
    filename: cwtPath,
    loaded: true,
    exports: {
      resolveSession: (opts) => {
        resolveSessionCalls.push(opts);
        return opts.session || 'autogen';
      },
      councilInvestigationPath: (ws, session) => path.join(ws, '.gh-maestro', `council-${session}.investigation.json`),
      resolveWorkspaceHead: () => SHA,
      ensureCouncilWorktree: () => path.join(os.tmpdir(), 'council-wt-test'),
    },
  };

  // run-council-investigation.js → child-wait.js → kill-tree.js が child-process.js の
  // spawnSync をロード時点で捕捉するため、キャッシュを必ず消して現在のモックを
  // 反映させる（kill-tree だけでなく、killProcessTree 参照を保持する child-wait も再ロード）
  const killTreePath = require.resolve('../../scripts/shared/kill-tree');
  const childWaitPath = require.resolve('../../scripts/shared/child-wait');
  delete require.cache[killTreePath];
  delete require.cache[childWaitPath];
  delete require.cache[modulePath];
  const mod = require(modulePath);

  delete require.cache[childProcessPath];
  delete require.cache[resolveConfigPath];
  delete require.cache[cwtPath];
  delete require.cache[killTreePath];
  delete require.cache[childWaitPath];
  return { mod, resolveSessionCalls, spawnSyncCalls };
}

/** テスト中だけ GH_MAESTRO_WORKSPACE を無効化し、元へ戻す。 */
function withEnvClean(fn) {
  const prev = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try { return fn(); } finally {
    if (prev !== undefined) process.env.GH_MAESTRO_WORKSPACE = prev;
  }
}

/** 一時ワークスペースを作り、後始末する。 */
function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-invest-test-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── buildInvestigationPrompt ───────────────────────────────────────────────────





// ── launchInvestigationJob ─────────────────────────────────────────────────────







test('launchInvestigationJob: タイムアウトは killProcessTree でプロセスツリーを終了する', async () => {
  // Windows では taskkill /T、それ以外ではプロセスグループ kill を使う
  // （run-council-jobs.test.js の全体タイムアウトテストと同型）。
  const child = fakeChild();
  child.pid = 1234;
  const origKill = process.kill;
  let processKillCalled = false;
  process.kill = () => { processKillCalled = true; return true; };
  try {
    const { mod, spawnSyncCalls } = loadModule({
      spawnImpl: () => child,
      spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const pending = mod.launchInvestigationJob({
      title: 'T', agenda: 'A', agentConfig: fakeAgentConfig(), worktreeDir: '/tmp/wt', workspace: '/tmp/ws', timeoutMs: 5,
    });
    // タイマー発火を待つ（実closeを待つとタイマーはクリアされてしまうため、先に発火を確認）
    await new Promise(r => setTimeout(r, 50));
    if (process.platform === 'win32') {
      assert.ok(spawnSyncCalls.some(c => c.cmd === 'taskkill' && c.args.includes('/T') && c.args.includes(String(child.pid))));
    } else {
      assert.ok(processKillCalled);
    }
    // タイマーでkillされた後、子プロセスの終了（close）で解決する
    child.emit('close', 137);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error, /exited with code 137/);
  } finally {
    process.kill = origKill;
  }
});

// ── runCouncilInvestigation（CLI）──────────────────────────────────────────────
