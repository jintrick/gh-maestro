'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const agentExec = require('../../scripts/shared/agent-exec');
const { buildLoginShellExecArgs, checkAgentExists } = agentExec;

// ── buildLoginShellExecArgs ──────────────────────────────────────────────────











test('buildLoginShellExecArgs: Unix の終了フックはエージェントコマンドを実行してから終了コードを渡す', (t) => {
  const bashProbe = spawnSync('bash', ['-lc', 'exit 0'], { encoding: 'utf8' });
  if (bashProbe.status !== 0) {
    t.skip('bash の実行環境が利用できない');
    return;
  }

  const args = buildLoginShellExecArgs(
    ['bash', '-lc', 'printf agent-ran; exit 7'],
    'linux',
    { command: 'bash', args: ['-lc', 'printf hook:$1', 'hook-shell'] },
  );
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });

  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /agent-ran/);
  assert.match(result.stdout, /hook:7/);
});

// ── win32: 終了コード検出の正確性（実障害の再発防止） ──────────────────────
//
// $LASTEXITCODE だけに頼ると、agentCmdArgs[0] がPATH上にもpwsh関数としても存在しない
// 場合（"command not found"）にネイティブプロセスが一度も起動せず $LASTEXITCODE が
// 更新されないため、onExitフックに exit code 0（成功）が渡ってしまっていた
// （実障害: config.jsonのextendsで登録したpwsh関数名の誤記や、Review Managerへの
// カスタムエージェント割り当て時にworker-exit-hook.jsの異常終了通知が発火しなかった）。

test(
  'buildLoginShellExecArgs: win32 — 存在しないコマンドはonExitフックへexit code 1を渡す',
  { skip: process.platform !== 'win32' ? 'win32専用（pwshの$?/$LASTEXITCODE実挙動を検証するテスト）' : false },
  () => {
    const args = buildLoginShellExecArgs(
      ['definitely-nonexistent-command-xyz-test'], 'win32',
      { command: process.execPath, args: ['-e', 'process.stdout.write("HOOK:" + process.argv[1])'] },
    );
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
    assert.match(result.stdout, /HOOK:1/, `存在しないコマンドはexit code 1として検出されるべき: ${result.stdout}`);
  },
);

test(
  'buildLoginShellExecArgs: win32 — 実在するコマンドの本物の非ゼロ終了コードは保持される（$?判定に握りつぶされない）',
  { skip: process.platform !== 'win32' ? 'win32専用（pwshの$?/$LASTEXITCODE実挙動を検証するテスト）' : false },
  () => {
    // 実在するコマンドが非ゼロで終了した場合、pwshは $? も False にする（$LASTEXITCODEとは別）。
    // $? を先に見ると本物の終了コード(7)が握りつぶされ一律 1 になる回帰がありうるため、
    // $LASTEXITCODE が設定されていれば常にそちらを優先することを確認する。
    const args = buildLoginShellExecArgs(
      [process.execPath, '-e', 'process.exit(7)'], 'win32',
      { command: process.execPath, args: ['-e', 'process.stdout.write("HOOK:" + process.argv[1])'] },
    );
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
    assert.match(result.stdout, /HOOK:7/, `実在コマンドの本物の終了コード7が保持されるべき: ${result.stdout}`);
  },
);

test(
  'buildLoginShellExecArgs: win32 — onExit無しでも存在しないコマンドはpwsh自身がexit 1する',
  { skip: process.platform !== 'win32' ? 'win32専用（pwshの$?/$LASTEXITCODE実挙動を検証するテスト）' : false },
  () => {
    const args = buildLoginShellExecArgs(['definitely-nonexistent-command-xyz-test2'], 'win32');
    const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8' });
    assert.equal(result.status, 1);
  },
);

// ── ログ複製（Tee-Object / tee）の撤去（Issue #151） ─────────────────────────
//
// パイプ経由のログ複製は非対話execモードのcodex/agyと非互換で本番クラッシュを起こした
// （Issue #150）。記録は shared/headless-launch.js のfd直接リダイレクトが担うため、
// この層はパイプを一切構築してはならない。再導入を機械的に検出するための回帰テスト。







// ── checkAgentExists ─────────────────────────────────────────────────────────







// ── 7引数（resume形）の終了フック引数渡し検証 ────────────────────────────
//
// 旧実装では bash 経路で $1,$2,$3 しかキャプチャしておらず、resume時に渡される
// 後半の引数（logPath, sinceTimestamp, logOffset, contractArg）がフックに届か
// なかった。このテストは7引数の onExit.args を実際の bash -lc 経由で実行し、
// 全引数 + 終了コードが正しくフックに渡っていることを確認する。
// フック（bash -c）自身が消費する -c / script / hook-shim の3引数に加え、
// resumeデータ4引数 + 終了コード1が届くことで、7引数設計の正当性を検証する。

test('buildLoginShellExecArgs: Unix の終了フックがresume時の7引数と終了コードを正しく渡す', (t) => {
  const bashProbe = spawnSync('bash', ['-lc', 'exit 0'], { encoding: 'utf8' });
  if (bashProbe.status !== 0) {
    t.skip('bash の実行環境が利用できない');
    return;
  }

  // 7個の onExit.args: bash -c の仕組み3個（-c/script/hook-shim）+
  // resumeデータ4個（ws/execId/logPath/sinceTimestamp ≒ worker-supervisor.js）
  const hook = {
    command: 'bash',
    args: [
      '-c',
      'echo "na=$#"; for a in "$@"; do echo "ARG:$a"; done',
      'hook-shim',
      '/test/ws', 'exec-42', '/logs/w.log', '2026-01-01T00:00:00Z',
    ],
  };

  const agentCmd = ['bash', '-lc', 'printf "agent-ran\n"; exit 0'];
  const unixArgs = buildLoginShellExecArgs(agentCmd, 'linux', hook);
  const result = spawnSync(unixArgs[0], unixArgs.slice(1), { encoding: 'utf8' });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const lines = result.stdout.split('\n').map(l => l.trim()).filter(Boolean);

  // エージェントコマンドが実行されたこと
  assert.ok(lines.includes('agent-ran'), `agent should run: ${lines.join(', ')}`);

  // bash -c 内の位置パラメータ: hook-shim($0)とすると$#=5（4 resume args + 1 exit code）
  assert.ok(lines.some(l => l === 'na=5'), `4 resume args + exit code: ${lines.join(', ')}`);

  // resumeデータが正しい順序で届いている
  const argLines = lines.filter(l => l.startsWith('ARG:'));
  assert.equal(argLines[0], 'ARG:/test/ws', 'workspace');
  assert.equal(argLines[1], 'ARG:exec-42', 'executionId');
  assert.equal(argLines[2], 'ARG:/logs/w.log', 'logPath');
  assert.equal(argLines[3], 'ARG:2026-01-01T00:00:00Z', 'sinceTimestamp');
  assert.equal(argLines[4], 'ARG:0', 'exit code should be last');
});
