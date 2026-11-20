'use strict';

// push-and-declare.js の CLI 境界テスト（slow 層。実プロセスを子として起動する）。
//
// .claude/rules/cli-input-validation-at-boundary.md: 引数検証は CLI 境界で、実際の argv と
// 終了状態を確かめる。main() の直接呼び出しでは parseFlags からの結線が外れても緑のままに
// なるため、ここでは spawnSync(process.execPath, [SCRIPT, ...args]) で起動する。
// 検証は副作用より前に行われる（読めない・空の申告表は git / gh に到達しない）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createTempDirScope } = require('../../scripts/shared/temp-directory');

const PUSH_AND_DECLARE_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'push-and-declare.js');

const tempDirScope = createTempDirScope();
test.after(() => tempDirScope.cleanup());

/** 子プロセスへ渡す環境。テスト実行中のガード（NODE_TEST_CONTEXT）は外す。 */
function cleanChildEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('CLI境界: --declaration-file が読めないと子プロセスは exit 1 で、git / gh に到達しない', () => {
  const ws = tempDirScope.mkdtemp('ghm-pad-cli-');
  const result = spawnSync(process.execPath, [
    PUSH_AND_DECLARE_SCRIPT, '--issue', '671', '--workspace', ws,
    '--declaration-file', path.join(ws, 'missing.md'),
  ], { cwd: ws, env: cleanChildEnv(), encoding: 'utf8' });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /--declaration-file を読めません/);
  assert.doesNotMatch(result.stderr, /git |gh /);
});

test('CLI境界: 空の --declaration-file は子プロセスで exit 1 になり、ブランチ検査より前に止まる', () => {
  const ws = tempDirScope.mkdtemp('ghm-pad-cli-');
  const declFile = path.join(ws, 'empty.md');
  fs.writeFileSync(declFile, '  \n', 'utf8');
  const result = spawnSync(process.execPath, [
    PUSH_AND_DECLARE_SCRIPT, '--issue', '671', '--workspace', ws, '--declaration-file', declFile,
  ], { cwd: ws, env: cleanChildEnv(), encoding: 'utf8' });
  assert.equal(result.status, 1, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /内容が空です/);
});
