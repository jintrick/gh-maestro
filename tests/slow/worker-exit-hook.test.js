'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = require('../../scripts/worker-exit-hook');
const { workerLogPath } = require('../../scripts/shared/headless-launch');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-exit-hook-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function commentEntry({ id, createdAt, from, to = 'orchestrator', body = '本文' }) {
  const marker = JSON.stringify({ v: 1, to, from });
  return {
    id,
    created_at: createdAt,
    body: `<!-- gh-maestro ${marker} -->\n> ${body}`,
  };
}

function prEntry({ number, createdAt }) {
  return {
    number,
    createdAt: createdAt,
  };
}

describe('verifyReplyAndRelayIfMissing', () => {
  let relayCalls;

  beforeEach(() => {
    relayCalls = [];
    hook._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }));
    hook._setRelayMessage((workspace, body) => {
      relayCalls.push({ workspace, body });
      return { status: 0, stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    hook._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }));
    hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
    hook._setGhPrList(() => ({ status: 0, stdout: '[]', stderr: '' }));
    hook._setRelayMessage(() => ({ status: 0, stdout: '', stderr: '' }));
  });











  // ── 応答契約 (artifact-or-message) ──────────────────────────────────────








});

// ═══════════════════════════════════════════════════════════════════════════
// normalizeToSecondPrecision: 秒精度への正規化
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizeToSecondPrecision', () => {


});

// ═══════════════════════════════════════════════════════════════════════════
// buildMsgSendRelayArgs: 本文を位置引数に含めない
// ═══════════════════════════════════════════════════════════════════════════

describe('buildMsgSendRelayArgs', () => {
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI: 引数個数によるresume/新規起動の判別
// ═══════════════════════════════════════════════════════════════════════════

const { spawnSync: realSpawnSync } = require('child_process');
const HOOK_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'worker-exit-hook.js');
// 実spawnする子プロセスにはワーカー文脈の環境変数（GH_MAESTRO_WORKER 等）を継承させない。
// 継承すると、非ゼロ終了時に worker-exit-hook.js の通知分岐が msg-send.js を呼び、
// 実ワークスペース・実Issueへ偽の異常終了通知を投稿する事故になる（Issue #202）。
const { cleanSpawnEnv } = require('../_spawn-env');

// 実spawnする hook サブプロセスへ rename EPERM を注入する preload（node -r で読み込ませる）。
// NODE_OPTIONS ではなく -r 引数を使う（NODE_OPTIONS は Windows のパス解析でバックスラッシュが
// 化けて読み込めないことを実機で確認済み）。
//   LOG_RENAME_FAIL_MODE=once   -> 1回目だけ失敗（リトライ成功を検証）
//   LOG_RENAME_FAIL_MODE=always -> 常に失敗（最終失敗のログ記録を検証）
const RENAME_INJECTOR_SOURCE = `
'use strict';
const fs = require('fs');
const originalRenameSync = fs.renameSync;
const mode = process.env.LOG_RENAME_FAIL_MODE;
if (mode === 'once' || mode === 'always') {
  let attempts = 0;
  fs.renameSync = (from, to) => {
    const isCompactionTarget = String(from).includes('.compact-') || String(to).endsWith('worker.log');
    if (isCompactionTarget && (mode === 'always' || attempts++ === 0)) {
      const err = new Error('simulated sharing violation (EPERM)');
      err.code = 'EPERM';
      throw err;
    }
    return originalRenameSync(from, to);
  };
}
`;

describe('CLI引数の解釈', () => {
  test('3引数（新規起動形）はcaptureLogPathの位置がexitCodeとして解釈される', () => {
    withTempDir((dir) => {
      // workspace, executionId, exitCode の3引数。GH_MAESTRO_WORKER無しなので
      // 異常終了通知・代理送信のいずれも発生しない（クラッシュしないことだけ確認）。
      const r = realSpawnSync(process.execPath, [HOOK_SCRIPT, dir, '', '0'], { encoding: 'utf8', timeout: 10000, env: cleanSpawnEnv() });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    });
  });

  test('6引数（resume形）でもGH_MAESTRO_WORKER無しならクラッシュしない', () => {
    withTempDir((dir) => {
      // agent-exec.js は常に終了コードを最後の引数として追加する
      // resume（6引数）: workspace, executionId, logPath, sinceTimestamp, logOffset, exitCode
      const r = realSpawnSync(process.execPath, [
        HOOK_SCRIPT, dir, '', path.join(dir, 'out.log'), '2024-01-01T00:00:00Z', '0',
      ], { encoding: 'utf8', timeout: 10000, env: cleanSpawnEnv() });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    });
  });

  test('7引数（resume+contract形）でもGH_MAESTRO_WORKER無しならクラッシュしない', () => {
    withTempDir((dir) => {
      // agent-exec.js は終了コードを必ず最後に追加する
      // resume+contract（7引数）: workspace, executionId, logPath, sinceTimestamp, logOffset, contractArg, exitCode
      const contract = JSON.stringify({ type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:00Z' });
      const r = realSpawnSync(process.execPath, [
        HOOK_SCRIPT, dir, '', path.join(dir, 'out.log'), '2024-01-01T00:00:00Z', contract, '0',
      ], { encoding: 'utf8', timeout: 10000, env: cleanSpawnEnv() });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    });
  });

  test('7引数（resume+contract形）で非ゼロ終了コードを正しく解釈できる（回帰）', () => {
    withTempDir((dir) => {
      // exit code 1 → 異常終了通知がトリガーされるが、GH_MAESTRO_WORKER が
      // 無いため通知は発生せず、引数解釈の誤りによるクラッシュだけを検証する
      const contract = JSON.stringify({ type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:00Z' });
      const r = realSpawnSync(process.execPath, [
        HOOK_SCRIPT, dir, '', path.join(dir, 'out.log'), '2024-01-01T00:00:00Z', contract, '1',
      ], { encoding: 'utf8', timeout: 10000, env: cleanSpawnEnv() });
      // GH_MAESTRO_WORKER 未設定なので異常終了通知は発生しない（msg-send がエラーになるだけ）
      // 重要なのは引数解釈の誤り（exitCode と contract の取り違え）でクラッシュしないこと
      // 非ゼロ終了コードの処理に失敗しても exit 0 でフック自体は正常完了する
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    });
  });

  test('新規起動形（3引数）でも GH_MAESTRO_WORKER があればワーカーログを圧縮する', () => {
    withTempDir((dir) => {
      const workerName = 'issue-5-fix';
      const logDir = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', workerName);
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'worker.log');
      const thinkingLine = '{"type":"system","subtype":"thinking_tokens","estimated_tokens":1,"estimated_tokens_delta":1,"uuid":"x","session_id":"y"}';
      const realLine = '{"type":"assistant","message":"hello"}';
      fs.writeFileSync(logPath, `${thinkingLine}\n${realLine}\n${thinkingLine}\n`);

      const env = { ...cleanSpawnEnv(), GH_MAESTRO_WORKER: workerName };
      const r = realSpawnSync(process.execPath, [HOOK_SCRIPT, dir, '', '0'], { encoding: 'utf8', timeout: 10000, env });

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(fs.readFileSync(logPath, 'utf8'), `${realLine}\n`);
    });
  });

  test('GH_MAESTRO_WORKER=orchestrator のときはワーカーログ圧縮をスキップする（Issue #384）', () => {
    withTempDir((dir) => {
      // orchestrator はワーカー名形式（issue-<N>-...）ではないため、
      // 以前の有無判定（if (workspace && workerName)）では workerLogPath が例外を投げ、
      // stderr に「ログ圧縮に失敗: cannot infer record owner...」が出力されていた。
      // isWorkerIdentity による値判定ではそもそもログ圧縮がスキップされるため、
      // stderr に圧縮失敗エラーが出力されず正常終了することを検証する。
      const env = { ...cleanSpawnEnv(), GH_MAESTRO_WORKER: 'orchestrator' };
      const r = realSpawnSync(process.execPath, [HOOK_SCRIPT, dir, '', '0'], { encoding: 'utf8', timeout: 10000, env });

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /ログ圧縮に失敗/, 'orchestrator名乗り時はログ圧縮が試みられずエラーが出ないこと');
    });
  });

  test('ワーカー終了フック経由で rename の一時的な EPERM をリトライで乗り越えて圧縮できる', () => {
    withTempDir((dir) => {
      const workerName = 'issue-5-fix';
      const logDir = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', workerName);
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'worker.log');
      const thinkingLine = '{"type":"system","subtype":"thinking_tokens","estimated_tokens":1,"estimated_tokens_delta":1,"uuid":"x","session_id":"y"}';
      const realLine = '{"type":"assistant","message":"hello"}';
      fs.writeFileSync(logPath, `${thinkingLine}\n${realLine}\n${thinkingLine}\n`);

      const injectorPath = path.join(dir, 'inject-rename.js');
      fs.writeFileSync(injectorPath, RENAME_INJECTOR_SOURCE);
      const env = { ...cleanSpawnEnv(), GH_MAESTRO_WORKER: workerName, LOG_RENAME_FAIL_MODE: 'once' };
      const r = realSpawnSync(process.execPath, ['-r', injectorPath, HOOK_SCRIPT, dir, '', '0'], { encoding: 'utf8', timeout: 10000, env });

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      // リトライ成功後はログからノイズ行が実際に消えている（例外が飛ばないことの確認では不十分）
      assert.equal(fs.readFileSync(logPath, 'utf8'), `${realLine}\n`);
    });
  });

  test('ワーカー終了フック経由で rename が最後まで失敗したら失敗がログ自体に記録される', () => {
    withTempDir((dir) => {
      const workerName = 'issue-5-fix';
      const logDir = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', workerName);
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'worker.log');
      const thinkingLine = '{"type":"system","subtype":"thinking_tokens","estimated_tokens":1,"estimated_tokens_delta":1,"uuid":"x","session_id":"y"}';
      const realLine = '{"type":"assistant","message":"hello"}';
      fs.writeFileSync(logPath, `${thinkingLine}\n${realLine}\n${thinkingLine}\n`);

      const injectorPath = path.join(dir, 'inject-rename.js');
      fs.writeFileSync(injectorPath, RENAME_INJECTOR_SOURCE);
      const env = { ...cleanSpawnEnv(), GH_MAESTRO_WORKER: workerName, LOG_RENAME_FAIL_MODE: 'always' };
      const r = realSpawnSync(process.execPath, ['-r', injectorPath, HOOK_SCRIPT, dir, '', '0'], { encoding: 'utf8', timeout: 10000, env });

      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const content = fs.readFileSync(logPath, 'utf8');
      // 失敗がログ自体に残り、あとからログを開いた人間に分かる（stderr 経由に依存しない）
      assert.match(content, /ログ圧縮に失敗しました/);
      assert.ok(content.includes(thinkingLine), 'ノイズ行が残っている');
      assert.ok(content.includes(realLine), '実質行も残っている');
      // tmp残骸が残らない
      assert.deepEqual(fs.readdirSync(logDir), ['worker.log']);
    });
  });

  // ── 回帰テスト（Issue #202） ─────────────────────────────────────────────
  // 実運用では `npm test` がワーカー起動コンテキスト（GH_MAESTRO_WORKER / GH_MAESTRO_WORKSPACE /
  // ISSUE が注入された状態）で実行されることがある。この環境を親プロセス（テストランナー）に
  // 再現し、実spawn CLIテストがそれらを子へ継承しない（= 異常終了通知を投稿しない）ことを検証する。
  // 万一 cleanSpawnEnv() が漏れて env がリークした場合も、親に注入する GH_MAESTRO_WORKSPACE は
  // git repo ではない一時dirを指すため、msg-send.js はリポジトリ解決で失敗し GitHub 投稿には
  // 至らない（テスト自体が安全）。リーク時は通知分岐が発火して stderr に「異常終了通知の投稿に失敗」
  // が出るため、下の doesNotMatch で回帰を検出できる。

  test('ワーカー文脈envが親に注入されていても実spawnは通知を投稿しない（回帰 #202）', () => {
    withTempDir((dir) => {
      const savedWorker = process.env.GH_MAESTRO_WORKER;
      const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
      const savedIssue = process.env.ISSUE;
      process.env.GH_MAESTRO_WORKER = 'issue-999-dummy';
      process.env.GH_MAESTRO_WORKSPACE = path.join(dir, 'not-a-repo');
      process.env.ISSUE = '999';
      try {
        // 非ゼロ終了コード + 親にワーカーenvが有る状態でも、cleanSpawnEnv() を適用した
        // 実spawnでは通知分岐が発火しない（msg-send.js への中継が走らない）。
        const r = realSpawnSync(process.execPath, [HOOK_SCRIPT, dir, '', '1'],
          { encoding: 'utf8', timeout: 10000, env: cleanSpawnEnv() });
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /異常終了通知/, `通知の投稿が試行されました: ${r.stderr}`);
      } finally {
        const restore = (key, value) => {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        };
        restore('GH_MAESTRO_WORKER', savedWorker);
        restore('GH_MAESTRO_WORKSPACE', savedWorkspace);
        restore('ISSUE', savedIssue);
      }
    });
  });
});
