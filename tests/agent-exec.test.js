'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildLoginShellExecArgs, checkAgentExists } = require('../scripts/agent-exec');

// ── buildLoginShellExecArgs ──────────────────────────────────────────────────

test('buildLoginShellExecArgs: win32 は pwsh -EncodedCommand を返す', () => {
  const args = buildLoginShellExecArgs(['claude', '--dangerously-skip-permissions', '-f', '/tmp/p.md', 'start'], 'win32');

  assert.equal(args[0], 'pwsh');
  assert.equal(args[1], '-NoLogo');
  assert.equal(args[2], '-EncodedCommand');
  assert.equal(args.length, 4);

  // 第4引数が有効な base64 であることを確認（UTF-16LE でデコード → 元のコマンド文字列）
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.startsWith('& "claude"'));
  assert.ok(decoded.includes('--dangerously-skip-permissions'));
  assert.ok(decoded.includes('/tmp/p.md'));
  assert.ok(decoded.endsWith('"start"'));
});

test('buildLoginShellExecArgs: win32 で引数内の " をエスケープする', () => {
  const args = buildLoginShellExecArgs(['claude', 'hello "world" test'], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes('"hello ""world"" test"'));
});

test('buildLoginShellExecArgs: win32 で空白を含むパスを安全に扱う', () => {
  const args = buildLoginShellExecArgs(['claude', '--append-system-prompt-file', 'C:/path with spaces/prompt.md', 'start'], 'win32');
  const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
  assert.ok(decoded.includes('"C:/path with spaces/prompt.md"'));
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

test('checkAgentExists: Unix で存在するコマンドを確認できる', () => {
  // プラットフォーム非依存テスト（明示的に 'linux' を指定）
  assert.equal(checkAgentExists('node', 'linux'), true);
  assert.equal(checkAgentExists('nonexistent-cmd-xyz-nix', 'linux'), false);
});

test('checkAgentExists: 異なるプラットフォーム指定で同一結果', () => {
  // node はどのプラットフォームでも解決可能
  assert.equal(checkAgentExists('node', 'win32'), true);
  assert.equal(checkAgentExists('node', 'linux'), true);
});
