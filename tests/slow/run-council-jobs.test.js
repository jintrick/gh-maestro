'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// run-council-jobs.js は child-process.js の spawn と shared/resolve-config.js の
// resolveAgentConfig / validateNonInteractiveTokens に依存する。実プロセスを0個
// spawn するため、両者をモックして再ロードする
//

const jobsPath = require.resolve('../../scripts/shared/run-council-jobs');
const childProcessPath = require.resolve('../../scripts/shared/child-process');
const agentLaunchPath = require.resolve('../../scripts/shared/agent-launch');
const agentExecPath = require.resolve('../../scripts/shared/agent-exec');
const resolveConfigPath = require.resolve('../../scripts/shared/resolve-config');

/** 既定のフェイクエージェント設定（非対話化トークン検証を素通りさせる） */
function fakeAgentConfig(overrides = {}) {
  return {
    id: 'claude-test',
    command: 'claude',
    promptDelivery: 'flag',
    promptFlag: '-p',
    execArgs: ['-p', '--skip-git-repo-check'],
    extraArgs: [],
    nonInteractiveTokens: [],
    ...overrides,
  };
}

/** 既定のフェイク子プロセス（stdout EventEmitter + kill） */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  child.pid = 1234;
  return child;
}

/**
 * child-process.js の spawn と resolve-config.js をモックした状態で
 * run-council-jobs.js を再ロードする。
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnImpl}      (cmd, args, opts) => child
 * @param {Function} [opts.spawnSyncImpl}  (cmd, args, opts) => { status, stdout, stderr }（killProcessTree 用）
 * @param {Function} [opts.resolveAgent}   (agentId, opts) => agentConfig|null
 * @param {Function} [opts.validateTokens} (agent, args) => { valid, missing }
 * @returns {{ mod, spawnCalls, spawnSyncCalls, agentCalls }}
 */
function loadModule(opts = {}) {
  const spawnCalls = [];
  const spawnSyncCalls = [];
  const agentCalls = [];

  const childProcessMock = {
    spawn: (cmd, args, o) => {
      spawnCalls.push({ cmd, args, opts: o });
      return opts.spawnImpl ? opts.spawnImpl(cmd, args, o) : fakeChild();
    },
    spawnSync: (cmd, args, o) => {
      spawnSyncCalls.push({ cmd, args, opts: o });
      return opts.spawnSyncImpl ? opts.spawnSyncImpl(cmd, args, o) : { status: 0, stdout: '', stderr: '' };
    },
    execSync: () => '',
  };
  const resolveConfigMock = {
    resolveAgentConfig: (agentId, o) => {
      agentCalls.push({ agentId, opts: o });
      return opts.resolveAgent ? opts.resolveAgent(agentId, o) : fakeAgentConfig();
    },
    validateNonInteractiveTokens: (agent, args) =>
      opts.validateTokens ? opts.validateTokens(agent, args) : { valid: true, missing: [] },
  };

  // run-council-jobs.js → child-wait.js → kill-tree.js が child-process.js の spawnSync を
  // ロード時点で捕捉するため、キャッシュを必ず消して現在のモックを反映させる
  // （kill-tree だけでなく、killProcessTree 参照を保持する child-wait も毎回再ロードする）
  const killTreePath = require.resolve('../../scripts/shared/kill-tree');
  const childWaitPath = require.resolve('../../scripts/shared/child-wait');
  for (const p of [childProcessPath, agentLaunchPath, agentExecPath, resolveConfigPath, jobsPath, killTreePath, childWaitPath]) {
    delete require.cache[p];
  }
  require.cache[childProcessPath] = { id: childProcessPath, filename: childProcessPath, loaded: true, exports: childProcessMock };
  require.cache[resolveConfigPath] = { id: resolveConfigPath, filename: resolveConfigPath, loaded: true, exports: resolveConfigMock };

  const mod = require(jobsPath);

  delete require.cache[childProcessPath];
  delete require.cache[resolveConfigPath];
  delete require.cache[killTreePath];
  delete require.cache[childWaitPath];
  return { mod, spawnCalls, spawnSyncCalls, agentCalls };
}

// ── マニフェストフィクスチャ ───────────────────────────────────────────────────

function opinionManifest(overrides = {}) {
  return {
    phase: 'opinion',
    session: 's1',
    title: 'RAG構成の採用可否',
    agenda: 'RAGを採用するかどうかを判断してください。',
    worktree: '/wt/council-wt-s1',
    participants: [
      { participant_id: 'p1', agent_id: 'claude-test' },
      { participant_id: 'p2', agent_id: 'codex-test' },
    ],
    context_appendix: '付録: リポジトリのRAG設定は config/rag.yaml を参照。',
    ...overrides,
  };
}

function voteManifest(overrides = {}) {
  return {
    ...opinionManifest(),
    phase: 'vote',
    opinions: [
      { participant_id: 'p1', opinion: '採用すべき。理由A。' },
      { participant_id: 'p2', opinion: '採用すべきでない。理由B。' },
    ],
    ...overrides,
  };
}

// ── validateManifest ───────────────────────────────────────────────────────────









// ── buildPhasePrompt ───────────────────────────────────────────────────────────







// ── validateParticipantOutput ──────────────────────────────────────────────────









// ── extractJsonObject ──────────────────────────────────────────────────────────








// ── extractJsonObject（内容ベース選別）──────────────────────────────────────────







/** 一時ワークスペースを作り、fn完了後に後始末する。 */
async function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-council-jobs-test-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── launchParticipantJob ───────────────────────────────────────────────────────









// ── runPhaseJobs ───────────────────────────────────────────────────────────────




test('runPhaseJobs: 全体タイムアウトで killProcessTree で残存ジョブを failed で返る', async () => {
  // killProcessTree は Windows では taskkill /T、それ以外ではプロセスグループ kill を使う。
  // どちらの経路でも「子プロセスが終了 → close 発火 → ジョブ解決」になるよう両方をモックする。
  const child = fakeChild();
  const origKill = process.kill;
  let processKillCalled = false;
  process.kill = (pid, sig) => { processKillCalled = true; child.emit('close', 137); return true; };
  try {
    const { mod, spawnSyncCalls } = loadModule({
      spawnImpl: () => child,
      spawnSyncImpl: (cmd, args) => {
        if (cmd === 'taskkill') child.emit('close', 137); // taskkill 相当の実効果
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    await withTempWorkspace(async (ws) => {
      const r = await mod.runPhaseJobs({
        manifest: opinionManifest(),
        workspace: ws,
        jobTimeoutMs: 5000,
        totalTimeoutMs: 20,
      });
      assert.equal(r.timedOut, true);
      assert.equal(r.ok, true);
      assert.equal(r.results.length, 2);
      assert.ok(r.results.every((x) => x.status === 'failed'));
      // Windows: taskkill /F /T /PID、それ以外: プロセスグループ kill
      if (process.platform === 'win32') {
        assert.ok(spawnSyncCalls.some((c) => c.cmd === 'taskkill' && c.args.includes('/T') && c.args.includes(String(child.pid))));
      } else {
        assert.ok(processKillCalled);
      }
    });
  } finally {
    process.kill = origKill;
  }
});
