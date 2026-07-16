'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const { buildLoginShellExecArgs, checkAgentExists } = require('../scripts/agent-exec');

/**
 * bash 経由で command -v を実行し、指定コマンドが解決可能か確認する。
 * WSL 導入済み Windows では bash --version は通るが WSL 内に node が無いケースが
 * あるため、単なる bash 存在確認では不十分。実際に command -v で解決できるかまで
 * 確認することで、実行環境の bash/node 有無に結果が左右されないようにする。
 */
function bashCanResolve(command) {
  try {
    const r = spawnSync('bash', ['-lc', `command -v '${command}' 2>/dev/null`], {
      encoding: 'utf8', stdio: 'pipe',
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

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
  assert.ok(decoded.endsWith("'start'"));
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

test('buildLoginShellExecArgs: 終了フックはエージェント終了後に実行IDと終了コードを渡す', () => {
  const hook = { command: 'node', args: ['/tmp/record-execution-exit.js', '/tmp/workspace', 'exec-42'] };
  const winArgs = buildLoginShellExecArgs(['codex-pro', 'start'], 'win32', hook);
  const decoded = Buffer.from(winArgs[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes("& 'node' '/tmp/record-execution-exit.js' '/tmp/workspace' 'exec-42' $exitCode"));

  const unixArgs = buildLoginShellExecArgs(['codex-pro', 'start'], 'linux', hook);
  assert.ok(unixArgs[2].includes('shift 4'));
  assert.deepEqual(unixArgs.slice(3, 7), ['node', '/tmp/record-execution-exit.js', '/tmp/workspace', 'exec-42']);
  assert.deepEqual(unixArgs.slice(7), ['codex-pro', 'start']);
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
  assert.equal(checkAgentExists('node'), true);
});

test('checkAgentExists: 存在しないコマンドは false を返す', () => {
  assert.equal(checkAgentExists('nonexistent-command-xyz-123-test'), false);
});

test('checkAgentExists: 空文字列は false を返す', () => {
  assert.equal(checkAgentExists(''), false);
});

test('checkAgentExists: win32 で存在するコマンドを確認できる', () => {
  if (process.platform === 'win32') {
    // Windows では node.exe が必ず存在する
    assert.equal(checkAgentExists('node', 'win32'), true);
    assert.equal(checkAgentExists('nonexistent-cmd-xyz-win', 'win32'), false);
  }
});

test('checkAgentExists: Unix で存在するコマンドを確認できる', (t) => {
  // bash 非存在または bash 経由で node が解決不能な環境ではスキップ
  // （WSL 導入済み Windows では bash はあるが WSL 内に node が無いケースがある）
  if (!bashCanResolve('node')) {
    t.diagnostic('bash cannot resolve node — skipping Unix checkAgentExists test');
    return;
  }
  assert.equal(checkAgentExists('node', 'linux'), true);
  assert.equal(checkAgentExists('nonexistent-cmd-xyz-nix', 'linux'), false);
});

test('checkAgentExists: 異なるプラットフォーム指定で同一結果', (t) => {
  // node はどのプラットフォームでも解決可能
  assert.equal(checkAgentExists('node', 'win32'), true);
  // linux の確認は bash 経由で node が解決可能な環境のみ
  if (!bashCanResolve('node')) {
    t.diagnostic('bash cannot resolve node — skipping linux cross-platform check');
  } else {
    assert.equal(checkAgentExists('node', 'linux'), true);
  }
});
