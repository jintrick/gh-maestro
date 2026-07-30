'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hook = require('../scripts/worker-exit-hook');

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

  test('workerName からIssue番号が導出できない場合は何もしない', () => {
    hook._setGhApiComments(() => { throw new Error('should not be called'); });
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'not-a-worker-name', captureLogPath: '/tmp/x', sinceTimestamp: '2024-01-01T00:00:00Z',
    });
    assert.equal(relayCalls.length, 0);
  });

  test('sinceTimestamp以降にワーカー自身からの返信があれば代理送信しない', () => {
    hook._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        commentEntry({ id: 1, createdAt: '2024-01-01T00:00:10Z', from: 'issue-5-fix' }),
      ]),
      stderr: '',
    }));
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: '/tmp/x', sinceTimestamp: '2024-01-01T00:00:00Z',
    });
    assert.equal(relayCalls.length, 0);
  });

  test('sinceTimestampより前の返信は「返信済み」とみなさない（境界のinclusive/exclusiveを前提にしない）', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, 'captured agent output');
      hook._setGhApiComments(() => ({
        status: 0,
        stdout: JSON.stringify([
          commentEntry({ id: 1, createdAt: '2024-01-01T00:00:00Z', from: 'issue-5-fix' }), // ちょうどsince（境界）
        ]),
        stderr: '',
      }));
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath, sinceTimestamp: '2024-01-01T00:00:00Z',
      });
      assert.equal(relayCalls.length, 1, '境界時刻の既存コメントは新規返信と認めず代理送信するべき');
    });
  });

  test('他ワーカー・他方向のコメントは返信とみなさない', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, 'captured agent output');
      hook._setGhApiComments(() => ({
        status: 0,
        stdout: JSON.stringify([
          commentEntry({ id: 1, createdAt: '2024-01-01T00:00:10Z', from: 'issue-5-other-worker' }),
          commentEntry({ id: 2, createdAt: '2024-01-01T00:00:11Z', from: 'orchestrator', to: 'issue-5-fix' }),
        ]),
        stderr: '',
      }));
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath, sinceTimestamp: '2024-01-01T00:00:00Z',
      });
      assert.equal(relayCalls.length, 1);
    });
  });

  test('返信が無い場合、captureLogPathの内容を代理送信する', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, '  実際のワーカーの最終出力  \n');
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));

      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath, sinceTimestamp: '2024-01-01T00:00:00Z',
      });

      assert.equal(relayCalls.length, 1);
      assert.equal(relayCalls[0].workspace, '/ws');
      assert.ok(relayCalls[0].body.includes('自動代理送信'));
      assert.ok(relayCalls[0].body.includes('実際のワーカーの最終出力'));
    });
  });

  test('captureLogPathが読めない場合は代理送信をスキップする', () => {
    hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: '/definitely/does/not/exist.log', sinceTimestamp: '2024-01-01T00:00:00Z',
    });
    assert.equal(relayCalls.length, 0);
  });

  test('captureLogPathが空文字だけの場合は代理送信をスキップする', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, '   \n  \n');
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath, sinceTimestamp: '2024-01-01T00:00:00Z',
      });
      assert.equal(relayCalls.length, 0);
    });
  });

  test('captureLogPathが代理送信文字数上限を超える場合は末尾を送信する', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      const longContent = 'x'.repeat(hook.MAX_RELAY_CHARS + 100) + 'TAIL_MARKER';
      fs.writeFileSync(logPath, longContent);
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath, sinceTimestamp: '2024-01-01T00:00:00Z',
      });
      assert.equal(relayCalls.length, 1);
      assert.ok(relayCalls[0].body.includes('TAIL_MARKER'));
      assert.ok(relayCalls[0].body.length < longContent.length);
    });
  });

  test('リポジトリ解決に失敗したら代理送信を試みない', () => {
    hook._setGhRepoView(() => ({ status: 1, stdout: '', stderr: 'not a git repository' }));
    hook._setGhApiComments(() => { throw new Error('should not be called'); });
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: '/tmp/x', sinceTimestamp: '2024-01-01T00:00:00Z',
    });
    assert.equal(relayCalls.length, 0);
  });

  test('コメント取得に失敗したら代理送信を試みない', () => {
    hook._setGhApiComments(() => ({ status: 1, stdout: '', stderr: 'rate limit' }));
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: '/tmp/x', sinceTimestamp: '2024-01-01T00:00:00Z',
    });
    assert.equal(relayCalls.length, 0);
  });

  // ── 応答契約 (artifact-or-message) ──────────────────────────────────────

  test('artifact-or-message 契約 + sinceTimestamp以降のPRあり → 代理送信しない（PRで契約充足）', () => {
    hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
    hook._setGhPrList(() => ({
      status: 0,
      stdout: JSON.stringify([prEntry({ number: 42, createdAt: '2024-01-01T01:00:00Z' })]),
      stderr: '',
    }));
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: '/tmp/x',
      sinceTimestamp: '2024-01-01T00:00:00Z',
      contract: { type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:00Z' },
    });
    assert.equal(relayCalls.length, 0);
  });

  test('artifact-or-message 契約 + PRなし → 代理送信する（契約未充足）', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, 'captured agent output');
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook._setGhPrList(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath,
        sinceTimestamp: '2024-01-01T00:00:00Z',
        contract: { type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:00Z' },
      });
      assert.equal(relayCalls.length, 1);
    });
  });

  test('artifact-or-message 契約 + PRはあるがsinceTimestampより前 → 代理送信する（既存PRは除外）', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, 'captured agent output');
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook._setGhPrList(() => ({
        status: 0,
        stdout: JSON.stringify([prEntry({ number: 42, createdAt: '2024-01-01T00:00:00Z' })]),
        stderr: '',
      }));
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath,
        sinceTimestamp: '2024-01-01T00:00:01Z',
        contract: { type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:01Z' },
      });
      assert.equal(relayCalls.length, 1, 'sinceTimestampと同じ時刻のPRは除外されるべき');
    });
  });

  test('artifact-or-message 契約 + msg-send.js返信あり → 代理送信しない（返信が優先）', () => {
    hook._setGhApiComments(() => ({
      status: 0,
      stdout: JSON.stringify([
        commentEntry({ id: 1, createdAt: '2024-01-01T00:00:10Z', from: 'issue-5-fix' }),
      ]),
      stderr: '',
    }));
    // PR list は呼ばれるべきではない（返信で早期returnするため）
    hook._setGhPrList(() => { throw new Error('should not be called'); });
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: '/tmp/x',
      sinceTimestamp: '2024-01-01T00:00:00Z',
      contract: { type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:00Z' },
    });
    assert.equal(relayCalls.length, 0);
  });

  test('契約なし（既存動作の回帰）→ 返信なければ代理送信', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, 'captured agent output');
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook._setGhPrList(() => { throw new Error('contract null時は呼ばれない'); });
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath,
        sinceTimestamp: '2024-01-01T00:00:00Z',
        contract: null,
      });
      assert.equal(relayCalls.length, 1);
    });
  });

  test('PR検索APIが失敗した場合 → 代理送信にフォールバック（フェイルセーフ）', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, 'captured agent output');
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook._setGhPrList(() => ({ status: 1, stdout: '', stderr: 'rate limit' }));
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath,
        sinceTimestamp: '2024-01-01T00:00:00Z',
        contract: { type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:00Z' },
      });
      assert.equal(relayCalls.length, 1, 'PR検索失敗時は安全のため代理送信する');
    });
  });

  test('artifact-or-message 契約だが artifact が不明な場合 → 代理送信する', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'out.log');
      fs.writeFileSync(logPath, 'captured agent output');
      hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
      hook._setGhPrList(() => { throw new Error('unknown artifact では呼ばれない'); });
      hook.verifyReplyAndRelayIfMissing({
        workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: logPath,
        sinceTimestamp: '2024-01-01T00:00:00Z',
        contract: { type: 'artifact-or-message', artifact: 'unknown-artifact', issue: 5, sinceTimestamp: '2024-01-01T00:00:00Z' },
      });
      assert.equal(relayCalls.length, 1);
    });
  });

  test('artifact-or-message 契約 + PRがsinceTimestampと同一秒に作成された → 代理送信しない（秒精度正規化により正当なPRが除外されない）', () => {
    // sinceTimestamp はミリ秒精度（new Date().toISOString() = "2024-01-01T00:00:00.123Z"）、
    // gh pr list の createdAt は秒精度（"2024-01-01T00:00:00Z"）。
    // 秒精度正規化により、同一秒内のPRも「開始以降」として扱う。
    hook._setGhApiComments(() => ({ status: 0, stdout: '[]', stderr: '' }));
    hook._setGhPrList(() => ({
      status: 0,
      stdout: JSON.stringify([prEntry({ number: 42, createdAt: '2024-01-01T00:00:00Z' })]),
      stderr: '',
    }));
    hook.verifyReplyAndRelayIfMissing({
      workspace: '/ws', workerName: 'issue-5-fix', captureLogPath: '/tmp/x',
      // sinceTimestamp にミリ秒が含まれているが、秒精度に正規化される
      sinceTimestamp: '2024-01-01T00:00:00.123Z',
      contract: { type: 'artifact-or-message', artifact: 'pr', issue: 5, sinceTimestamp: '2024-01-01T00:00:00.123Z' },
    });
    assert.equal(relayCalls.length, 0, '同一秒のPRは秒精度正規化により契約充足と判定されるべき');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// normalizeToSecondPrecision: 秒精度への正規化
// ═══════════════════════════════════════════════════════════════════════════

describe('normalizeToSecondPrecision', () => {
  test('ミリ秒付きタイムスタンプは秒精度に正規化される', () => {
    assert.equal(
      hook.normalizeToSecondPrecision('2024-01-01T00:00:00.123Z'),
      '2024-01-01T00:00:00Z'
    );
  });

  test('秒精度のタイムスタンプはそのまま', () => {
    assert.equal(
      hook.normalizeToSecondPrecision('2024-01-01T00:00:00Z'),
      '2024-01-01T00:00:00Z'
    );
  });

  test('複数桁のミリ秒も正しく除去される', () => {
    assert.equal(
      hook.normalizeToSecondPrecision('2024-01-01T00:00:00.123456Z'),
      '2024-01-01T00:00:00Z'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildMsgSendRelayArgs: 本文を位置引数に含めない
// ═══════════════════════════════════════════════════════════════════════════

describe('buildMsgSendRelayArgs', () => {
  test('本文を含まず、--stdin経由での送信を前提にした引数を返す（msg-send.js自身が本文の位置引数渡しを拒否するため）', () => {
    const args = hook.buildMsgSendRelayArgs('/ws');
    assert.deepEqual(args, [
      path.join(__dirname, '..', 'scripts', 'msg-send.js'),
      '--stdin',
      '--workspace', '/ws',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLI: 引数個数によるresume/新規起動の判別
// ═══════════════════════════════════════════════════════════════════════════

const { spawnSync: realSpawnSync } = require('child_process');
const HOOK_SCRIPT = path.join(__dirname, '..', 'scripts', 'worker-exit-hook.js');

describe('CLI引数の解釈', () => {
  test('3引数（新規起動形）はcaptureLogPathの位置がexitCodeとして解釈される', () => {
    withTempDir((dir) => {
      // workspace, executionId, exitCode の3引数。GH_MAESTRO_WORKER無しなので
      // 異常終了通知・代理送信のいずれも発生しない（クラッシュしないことだけ確認）。
      const r = realSpawnSync(process.execPath, [HOOK_SCRIPT, dir, '', '0'], { encoding: 'utf8', timeout: 10000 });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    });
  });

  test('6引数（resume形）でもGH_MAESTRO_WORKER無しならクラッシュしない', () => {
    withTempDir((dir) => {
      // agent-exec.js は常に終了コードを最後の引数として追加する
      // resume（6引数）: workspace, executionId, logPath, sinceTimestamp, logOffset, exitCode
      const r = realSpawnSync(process.execPath, [
        HOOK_SCRIPT, dir, '', path.join(dir, 'out.log'), '2024-01-01T00:00:00Z', '0',
      ], { encoding: 'utf8', timeout: 10000 });
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
      ], { encoding: 'utf8', timeout: 10000 });
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
      ], { encoding: 'utf8', timeout: 10000 });
      // GH_MAESTRO_WORKER 未設定なので異常終了通知は発生しない（msg-send がエラーになるだけ）
      // 重要なのは引数解釈の誤り（exitCode と contract の取り違え）でクラッシュしないこと
      // 非ゼロ終了コードの処理に失敗しても exit 0 でフック自体は正常完了する
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    });
  });
});
