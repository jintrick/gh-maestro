#!/usr/bin/env node
'use strict';

// run-slow-tests.js — orchestrator／人間向けのslow層全件実行入口。
// 層の解決、コマンドの組み立て、成果物の書き出し、終了コード処理は
// run-tests.js に委譲し、この入口では実行主体と「全件」を固定する。

const { runTests } = require('./run-tests');
const { parseFlags } = require('./shared/workspace');

const TEST_ACTOR = 'run-slow-tests';

const USAGE = `run-slow-tests.js — 宣言されたslow層を全件実行し、結果成果物を生成する

Usage:
  node run-slow-tests.js [--workspace <path>]

Options:
  --workspace <path>   test.layersを読むプロジェクトのworkspace（省略時はCWDから解決）
  --help, -h           Usageを表示して終了する

Output:
  宣言されたslow層のrunner出力を標準出力／標準エラーへ中継します。
  結果はrun-tests.jsと同じruntime rootへworktree単位で保存します。
  exit 0 = 宣言コマンド成功、exit 1以上 = 宣言コマンド失敗または起動失敗`;

const SPEC = {
  flags: { '--workspace': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

/**
 * slow層を対象ファイル指定なしで実行する。実行処理はrun-tests.jsへ委譲する。
 *
 * @param {{workspace?:string, cwd?:string, env?:object, homedir?:string}} params
 * @param {{runTestsFn?:Function}} [deps]
 * @returns {{exitCode:number, artifact:object|null, artifactWritten:boolean, stdout:string, stderr:string}}
 */
function runSlowTests({ workspace, cwd = process.cwd(), env = process.env, homedir } = {}, deps = {}) {
  const runTestsFn = deps.runTestsFn || runTests;
  const { runTestsFn: _unused, ...runnerDeps } = deps;
  return runTestsFn({
    suite: 'slow',
    testFiles: [],
    changedFiles: [],
    workspace,
    cwd,
    homedir,
    env: {
      ...env,
      GH_MAESTRO_TEST_ACTOR: TEST_ACTOR,
    },
  }, runnerDeps);
}

function main(argv, deps = {}) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { exitCode: 0, stdout: USAGE };
    return { exitCode: 1, stderr: `run-slow-tests: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) return { exitCode: 0, stdout: USAGE };

  const result = runSlowTests({
    workspace: values['--workspace'],
    cwd: process.cwd(),
    env: process.env,
  }, deps);
  return {
    exitCode: result.exitCode,
    stdout: '',
    stderr: result.artifact === null ? result.stderr : '',
  };
}

module.exports = {
  TEST_ACTOR,
  USAGE,
  SPEC,
  runSlowTests,
  main,
};

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
