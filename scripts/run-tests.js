#!/usr/bin/env node
'use strict';

// run-tests.js — Node test runner の実行とテスト結果成果物の生成を一体化する。
//
// このスクリプト自身が TAP summary を解析して runtime root へ成果物を書き出すため、
// コーダーが fail/pass を数えて申告コマンドへ入力する経路はない。子プロセスの終了
// コードはそのまま返すが、テストが赤くても summary が読める限り成果物は保存する。

const fs = require('fs');
const { spawnSync } = require('./shared/child-process');
const { resolveGitHead } = require('./shared/git-head');
const { parseFlags } = require('./shared/workspace');
const {
  TEST_RESULT_SCHEMA_VERSION,
  TEST_RESULT_PRODUCER,
  TEST_RESULT_PROVENANCE,
  parseTapSummary,
  testResultPath,
  writeTestResultArtifact,
} = require('./shared/test-result');

const SUITES = Object.freeze({
  full: Object.freeze({
    scope: 'full',
    command: 'npm test',
    testArgs: ['--require', './tests/_env-setup.js', '--test', 'tests/*.test.js'],
  }),
  slow: Object.freeze({
    scope: 'partial',
    command: 'npm run test:slow',
    testArgs: ['--require', './tests/_env-setup.js', '--test', 'tests/slow/*.test.js'],
  }),
});

const USAGE = `run-tests.js — Node test runnerを実行し、結果成果物を生成する

Usage:
  node run-tests.js <full|slow>

Arguments:
  full                  npm test 相当。tests/*.test.js を全件実行し、scope=fullで記録
  slow                  npm run test:slow 相当。tests/slow/*.test.jsを実行し、scope=partialで記録

Output:
  Node test runner の出力をそのまま標準出力/標準エラーへ中継します。
  結果は storage-layout.js の runtime root に worktree 単位で保存します。
  テストが失敗しても、成果物が生成できた場合はその結果を保存して同じ終了コードを返します。
  exit 0 = test runner成功、exit 1以上 = test runner失敗または起動失敗`;

const SPEC = {
  flags: {},
  booleans: ['--help', '-h'],
  positionals: { min: 1, max: 1 },
};

function clearPreviousArtifact(worktree) {
  try {
    fs.unlinkSync(testResultPath(worktree));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function exitCodeForChild(result) {
  if (result && Number.isInteger(result.status) && result.status >= 0) return result.status;
  return 1;
}

function outputText(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 指定されたテストスイートを1回実行し、TAP summaryから成果物を作る。
 *
 * @param {{suite:string, cwd?:string, env?:object}} params
 * @param {object} [deps]
 * @param {Function} [deps.spawnSyncFn]
 * @param {Function} [deps.resolveGitHeadFn]
 * @param {Function} [deps.clearArtifactFn]
 * @param {Function} [deps.writeArtifactFn] (worktree, artifact) => void
 * @param {Function} [deps.writeStdoutFn]
 * @param {Function} [deps.writeStderrFn]
 * @returns {{exitCode:number, artifact:object, artifactWritten:boolean, stdout:string, stderr:string}}
 */
function runTests({ suite, cwd = process.cwd(), env = process.env } = {}, deps = {}) {
  const selected = SUITES[suite];
  if (!selected) {
    return {
      exitCode: 1,
      artifact: null,
      artifactWritten: false,
      stdout: '',
      stderr: `未知のテストスイートです: ${suite}`,
    };
  }

  const spawnSyncFn = deps.spawnSyncFn || spawnSync;
  const resolveGitHeadFn = deps.resolveGitHeadFn || resolveGitHead;
  const clearArtifactFn = deps.clearArtifactFn || clearPreviousArtifact;
  const writeArtifactFn = deps.writeArtifactFn || writeTestResultArtifact;
  const writeStdoutFn = deps.writeStdoutFn || ((text) => process.stdout.write(text));
  const writeStderrFn = deps.writeStderrFn || ((text) => process.stderr.write(text));

  try {
    clearArtifactFn(cwd);
  } catch (error) {
    // 古い成果物を消せなくても test runner 自体は実行する。新しい成果物の書き出しに
    // 失敗した場合は申告入口が unknown へ縮退するため、古い値を成功結果として使わない。
    writeStderrFn(`テスト結果成果物の旧ファイルを削除できません: ${error.message}\n`);
  }

  let testedHead = null;
  try {
    testedHead = resolveGitHeadFn(cwd);
  } catch {
    // テスト結果の集計にHEAD解決は不要。対象SHAは申告入口が現在のHEADから解決する。
  }

  const child = spawnSyncFn(process.execPath, testArgsFor(selected), {
    cwd,
    env,
    encoding: 'utf8',
  }) || {};
  const stdout = outputText(child.stdout);
  const stderr = outputText(child.stderr);
  if (stdout) writeStdoutFn(stdout);
  if (stderr) writeStderrFn(stderr);

  const summary = parseTapSummary(`${stdout}${stderr ? `\n${stderr}` : ''}`);
  const recordedAt = new Date().toISOString();
  let artifact;
  if (summary.ok) {
    artifact = {
      schemaVersion: TEST_RESULT_SCHEMA_VERSION,
      producer: TEST_RESULT_PRODUCER,
      provenance: TEST_RESULT_PROVENANCE,
      scope: selected.scope,
      status: 'complete',
      command: selected.command,
      recordedAt,
      testedHead,
      ...summary.summary,
    };
  } else {
    artifact = {
      schemaVersion: TEST_RESULT_SCHEMA_VERSION,
      producer: TEST_RESULT_PRODUCER,
      provenance: TEST_RESULT_PROVENANCE,
      scope: selected.scope,
      status: 'unavailable',
      command: selected.command,
      recordedAt,
      testedHead,
      reason: child.error ? 'runner-start-failed' : 'tap-summary-invalid',
    };
  }

  let artifactWritten = false;
  try {
    writeArtifactFn(cwd, artifact);
    artifactWritten = true;
  } catch (error) {
    // 成果物生成失敗で test runner の終了コードを隠さない。申告側はファイル欠落として
    // unknown を投稿し、push/PR/申告を止めない。
    writeStderrFn(`テスト結果成果物を書き出せません: ${error.message}\n`);
  }

  return {
    exitCode: exitCodeForChild(child),
    artifact,
    artifactWritten,
    stdout,
    stderr,
  };
}

function testArgsFor(selected) {
  return [...selected.testArgs];
}

function main(argv) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { exitCode: 0, stdout: USAGE };
    return { exitCode: 1, stderr: `run-tests: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) return { exitCode: 0, stdout: USAGE };

  const result = runTests({ suite: rest[0], cwd: process.cwd(), env: process.env });
  return {
    exitCode: result.exitCode,
    stdout: '',
    stderr: result.artifact === null ? result.stderr : '',
  };
}

module.exports = {
  SUITES,
  USAGE,
  SPEC,
  testArgsFor,
  runTests,
  main,
};

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
