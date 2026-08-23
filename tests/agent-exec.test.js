'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const agentExec = require('../scripts/shared/agent-exec');
const { buildLoginShellExecArgs, checkAgentExists } = agentExec;

// ── buildLoginShellExecArgs ──────────────────────────────────────────────────

test('buildLoginShellExecArgs: win32 は pwsh -EncodedCommand を返す', () => {
  const args = buildLoginShellExecArgs(['claude', '--dangerously-skip-permissions', '-f', '/tmp/p.md', 'start'], 'win32');

  assert.equal(args[0], 'pwsh');
  assert.equal(args[1], '-NoLogo');
  assert.equal(args[2], '-EncodedCommand');
  assert.equal(args.length, 4);

  // 第4引数が有効な base64 であることを確認（UTF-16LE でデコード → 元のコマンド文字列）
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.startsWith("& 'claude'"));
  assert.ok(decoded.includes('--dangerously-skip-permissions'));
  assert.ok(decoded.includes('/tmp/p.md'));
  // onExitが無くても、&は bash の exec と違いプロセスを置き換えないため、
  // $LASTEXITCODE を明示的に exit しないと呼び出し元が子の終了コードを見失う。
  assert.ok(decoded.includes("'start'; $exitCode ="));
  assert.ok(decoded.endsWith('exit $exitCode'));
});

test('buildLoginShellExecArgs: win32 で引数内の \' をエスケープする', () => {
  const args = buildLoginShellExecArgs(['claude', "hello 'world' test"], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("'hello ''world'' test'"));
});

test('buildLoginShellExecArgs: win32 で空白を含むパスを安全に扱う', () => {
  const args = buildLoginShellExecArgs(['claude', '--append-system-prompt-file', 'C:/path with spaces/prompt.md', 'start'], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("'C:/path with spaces/prompt.md'"));
});

test('buildLoginShellExecArgs: win32 で $ を含む引数を変数展開せず維持する', () => {
  const args = buildLoginShellExecArgs(['claude-ds', '--model', '$DEEPSEEK_MODEL', 'C:/path/$VAR/prompt.md'], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  // single-quote なので $ はそのままリテラル
  assert.ok(decoded.includes("'$DEEPSEEK_MODEL'"));
  assert.ok(decoded.includes("'C:/path/$VAR/prompt.md'"));
  // シングルクォートの外に $ がないことを確認
  assert.ok(!decoded.includes('"$'), 'double-quoted $ が残っていない');
});

test('buildLoginShellExecArgs: win32 で env をコマンド冒頭に $env: で注入する', () => {
  const args = buildLoginShellExecArgs(['claude-ds-pro', '--print'], 'win32', null,
    { GH_MAESTRO_WORKER: 'issue-247-x', GH_MAESTRO_WORKSPACE: 'C:\\Users\\J\\gijiai' });
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.startsWith("$env:GH_MAESTRO_WORKER='issue-247-x'; "));
  // バックスラッシュはシングルクォート内でリテラル保持される
  assert.ok(decoded.includes("$env:GH_MAESTRO_WORKSPACE='C:\\Users\\J\\gijiai'; "));
  // env の後に本来の & 呼び出しが続く
  assert.ok(decoded.includes("& 'claude-ds-pro' '--print'"));
});

test('buildLoginShellExecArgs: win32 で env が空なら従来通りプリフィックス無し', () => {
  const args = buildLoginShellExecArgs(['claude', '--print'], 'win32', null, {});
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.startsWith("& 'claude'"));
});

test('buildLoginShellExecArgs: Unix で env を export で注入する', () => {
  const args = buildLoginShellExecArgs(['agy', '--print'], 'linux', null, { GH_MAESTRO_WORKER: 'issue-9-x' });
  assert.equal(args[0], 'bash');
  assert.equal(args[1], '-lc');
  assert.ok(args[2].startsWith("export GH_MAESTRO_WORKER='issue-9-x'; "));
  assert.ok(args[2].includes('exec "$0" "$@"'));
});

test('buildLoginShellExecArgs: Unix は bash -lc exec を返す', () => {
  const args = buildLoginShellExecArgs(['claude', '--dangerously-skip-permissions', '-f', '/tmp/p.md'], 'linux');

  assert.equal(args[0], 'bash');
  assert.equal(args[1], '-lc');
  assert.equal(args[2], 'exec "$0" "$@"');
  assert.deepEqual(args.slice(3), ['claude', '--dangerously-skip-permissions', '-f', '/tmp/p.md']);
});

test('buildLoginShellExecArgs: Unix で空白を含む引数を argv として維持する', () => {
  const args = buildLoginShellExecArgs(['claude', '--append-system-prompt-file', '/path/with spaces/prompt.md', 'multi\nline'], 'linux');

  assert.equal(args[3], 'claude');
  assert.equal(args[5], '/path/with spaces/prompt.md');
  assert.equal(args[6], 'multi\nline');
});

test('buildLoginShellExecArgs: 終了フックはエージェント終了後に引数と終了コードを渡す', () => {
  const hook = { command: 'node', args: ['/tmp/worker-exit-hook.js', '/tmp/workspace', 'exec-42'] };
  const winArgs = buildLoginShellExecArgs(['codex-pro', 'start'], 'win32', hook);
  const decoded = Buffer.from(winArgs[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("& 'node' '/tmp/worker-exit-hook.js' '/tmp/workspace' 'exec-42' $exitCode"));

  const unixArgs = buildLoginShellExecArgs(['codex-pro', 'start'], 'linux', hook);
  assert.ok(unixArgs[2].includes('_i -lt 3'), '動的ループで3個のonExit.argsをキャプチャする');
  assert.deepEqual(unixArgs.slice(3, 7), ['node', '/tmp/worker-exit-hook.js', '/tmp/workspace', 'exec-42']);
  assert.deepEqual(unixArgs.slice(7), ['codex-pro', 'start']);
});

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

test('buildLoginShellExecArgs: win32 でパイプによるログ複製を一切構築しない', () => {
  const decoded = (args) => Buffer.from(args[3], 'base64').toString('utf16le');

  const plain = decoded(buildLoginShellExecArgs(['claude-ds', '--print'], 'win32'));
  assert.ok(!plain.includes('Tee-Object'), plain);
  assert.ok(!plain.includes('|'), `パイプ演算子が含まれない: ${plain}`);
  assert.equal(plain, "& 'claude-ds' '--print'; $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } elseif (-not $?) { 1 } else { 0 }; exit $exitCode");

  // onExit・env を併用しても同じ（パイプは増えない）
  const withHook = decoded(buildLoginShellExecArgs(
    ['claude-ds', '--print'], 'win32',
    { command: 'node', args: ['/ws/worker-exit-hook.js', '/ws', ''] },
    { GH_MAESTRO_WORKER: 'issue-5-x' },
  ));
  assert.ok(!withHook.includes('Tee-Object'), withHook);
  assert.ok(!withHook.includes('|'), `パイプ演算子が含まれない: ${withHook}`);
});

test('buildLoginShellExecArgs: Unix でパイプ・プロセス置換によるログ複製を一切構築しない', () => {
  const plain = buildLoginShellExecArgs(['claude-ds', '--print'], 'linux')[2];
  assert.ok(!plain.includes('tee'), plain);
  assert.ok(!plain.includes('>('), `プロセス置換が含まれない: ${plain}`);
  assert.equal(plain, 'exec "$0" "$@"');

  const withHook = buildLoginShellExecArgs(
    ['claude-ds', '--print'], 'linux',
    { command: 'node', args: ['/ws/worker-exit-hook.js', '/ws', ''] },
    { GH_MAESTRO_WORKER: 'issue-5-x' },
  )[2];
  assert.ok(!withHook.includes('tee'), withHook);
  assert.ok(!withHook.includes('>('), `プロセス置換が含まれない: ${withHook}`);
});

test('buildLoginShellExecArgs: captureLogPath 相当の第5引数はもう受け付けない（渡しても無視される）', () => {
  // 呼び出し元の削除漏れがあっても、パイプが復活しないことを保証する。
  const args = buildLoginShellExecArgs(['claude-ds'], 'win32', null, {}, 'C:\\ws\\out.log');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(!decoded.includes('out.log'), decoded);
  assert.ok(!decoded.includes('Tee-Object'), decoded);
});

test('agent-exec: buildPwshCaptureClauses はエクスポートされていない', () => {
  const agentExec = require('../scripts/shared/agent-exec');
  assert.equal(agentExec.buildPwshCaptureClauses, undefined);
});

test('buildLoginShellExecArgs: 空配列でエラーになる', () => {
  assert.throws(() => buildLoginShellExecArgs([]), /non-empty array/);
  assert.throws(() => buildLoginShellExecArgs(null), /non-empty array/);
  assert.throws(() => buildLoginShellExecArgs(undefined), /non-empty array/);
});

test('buildLoginShellExecArgs: デフォルトプラットフォームが process.platform を使う', () => {
  // 実行環境のプラットフォームが win32 かそれ以外かで期待値を変える
  const isWin = process.platform === 'win32';
  const args = buildLoginShellExecArgs(['agy', '-i', 'hello']);
  assert.equal(args[0], isWin ? 'pwsh' : 'bash');
});

// ── checkAgentExists ─────────────────────────────────────────────────────────

test('checkAgentExists: node は存在する', () => {
  agentExec._setSpawnSync(() => ({ status: 0 }));
  assert.equal(checkAgentExists('node'), true);
});

test('checkAgentExists: 存在しないコマンドは false を返す', () => {
  agentExec._setSpawnSync(() => ({ status: 1 }));
  assert.equal(checkAgentExists('nonexistent-command-xyz-123-test'), false);
});

test('checkAgentExists: 空文字列は false を返す', () => {
  assert.equal(checkAgentExists(''), false);
});

test('checkAgentExists: win32 で存在するコマンドを確認できる', () => {
  agentExec._setSpawnSync(() => ({ status: 0 }));
  if (process.platform === 'win32') {
    // Windows では node.exe が必ず存在する
    assert.equal(checkAgentExists('node', 'win32'), true);
    agentExec._setSpawnSync(() => ({ status: 1 }));
    assert.equal(checkAgentExists('nonexistent-cmd-xyz-win', 'win32'), false);
  }
});

test('checkAgentExists: Unix で存在するコマンドを確認できる', (t) => {
  agentExec._setSpawnSync(() => ({ status: 0 }));
  assert.equal(checkAgentExists('node', 'linux'), true);
  agentExec._setSpawnSync(() => ({ status: 1 }));
  assert.equal(checkAgentExists('nonexistent-cmd-xyz-nix', 'linux'), false);
});

test('checkAgentExists: 異なるプラットフォーム指定で同一結果', (t) => {
  agentExec._setSpawnSync(() => ({ status: 0 }));
  // node はどのプラットフォームでも解決可能
  assert.equal(checkAgentExists('node', 'win32'), true);
  assert.equal(checkAgentExists('node', 'linux'), true);
});

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
