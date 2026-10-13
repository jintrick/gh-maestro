#!/usr/bin/env node
'use strict';

// /gh-maestro の UserPromptExpansion hook から呼ばれる単一エントリポイント。
// Claude Code は同一イベントに一致する hook handler を並列実行するため、legacy inspection・
// setup・reset・context を別々の handler として登録すると、整理処理の
// 前後で検査結果とcontextがずれる競合が起きる。ここでは兄弟CLIを同期実行し、
// 全段階の成功後だけ stdout をhookへ返す。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./shared/child-process');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { parseJsonText } = require('./shared/json-file');
const { markOrchestratorSession } = require('./orchestrator-stop-hook');

const USAGE = `gh-maestro-session-hook.js — /gh-maestro のセッション開始hook

Usage: node gh-maestro-session-hook.js [--workspace <path>]

Options:
  --workspace <path>  対象プロジェクトのルート（省略時は
                      CLAUDE_PROJECT_DIR、GH_MAESTRO_WORKSPACE、CWD探索の順で解決）
  --help, -h          このusageを表示

実行順:
  1. check-legacy.js --workspace <workspace>
  2. gh-maestro-setup.js <workspace>
  3. reset-session.js --workspace <workspace> --quiet
  4. get-context.js
  5. 標準入力のhook入力JSONにある session_id を、orchestratorセッションとして記録する
     （orchestrator-stop-hook.js が通知の対象を見分けるため。標準入力がTTYなら省略）

全段階が終了コード0のときだけ、各段階のstdoutをこのhookのstdoutへ出力する。
途中で失敗した場合は後続段階を実行せず、stdoutを出力しない。
5の記録に失敗しても警告を出すだけで、セッション開始は失敗させない。`;

const SPEC = {
  flags: { '--workspace': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

function outputText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function stageDefinitions(workspace, scriptsDir = __dirname) {
  return [
    {
      name: 'check-legacy.js',
      args: [path.join(scriptsDir, 'check-legacy.js'), '--workspace', workspace],
    },
    {
      name: 'gh-maestro-setup.js',
      args: [path.join(scriptsDir, 'gh-maestro-setup.js'), workspace],
    },
    {
      name: 'reset-session.js',
      args: [path.join(scriptsDir, 'reset-session.js'), '--workspace', workspace, '--quiet'],
    },
    {
      name: 'get-context.js',
      args: [path.join(scriptsDir, 'get-context.js')],
    },
  ];
}

function exitCodeFromResult(result) {
  return result && Number.isInteger(result.status) && result.status > 0
    ? result.status
    : 1;
}

function formatStageFailure(stage, result, error) {
  const detail = error ? error.message : '';
  const suffix = detail ? `: ${detail}` : '';
  return `gh-maestro-session-hook: ${stage.name} failed (exit ${exitCodeFromResult(result)})${suffix}\n`;
}

/**
 * セッション開始に必要な4段階を、同じworkspaceの同期子プロセスとして実行する。
 *
 * stdoutは成功が確定するまで保持する。get-context.jsが返すcontextを途中で流すと、
 * 後段の失敗時にも古いSESSION_IDがClaude Codeへ注入されるためである。
 *
 * @param {string} workspace 解決済みworkspace
 * @param {object} [options]
 * @param {string} [options.scriptsDir] 兄弟CLIのディレクトリ（既定: このスクリプトの配置先）
 * @param {object} [options.env] 子プロセスへ渡す環境変数のベース
 * @param {Function} [options.spawnSyncFn] テスト用の同期spawn差し替え
 * @returns {{ok:boolean, exitCode:number, stdout:string, stderr:string, failedStage?:string}}
 */
function runSessionHook(workspace, options = {}) {
  const run = options.spawnSyncFn || spawnSync;
  const scriptsDir = options.scriptsDir || __dirname;
  const childEnv = {
    ...(options.env || process.env),
    CLAUDE_PROJECT_DIR: workspace,
    GH_MAESTRO_WORKSPACE: workspace,
  };
  const stdout = [];
  const stderr = [];

  for (const stage of stageDefinitions(workspace, scriptsDir)) {
    let result;
    let spawnError = null;
    try {
      result = run(process.execPath, stage.args, {
        cwd: workspace,
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error;
    }

    if (spawnError || !result || result.error || result.status !== 0) {
      return {
        ok: false,
        exitCode: exitCodeFromResult(result),
        stdout: '',
        stderr: formatStageFailure(stage, result, spawnError || result?.error)
          + outputText(result && result.stderr),
        failedStage: stage.name,
      };
    }

    stdout.push(outputText(result.stdout));
    stderr.push(outputText(result.stderr));
  }

  return {
    ok: true,
    exitCode: 0,
    stdout: stdout.join(''),
    stderr: stderr.join(''),
  };
}

/**
 * hook入力の session_id を orchestrator セッションとして記録する。
 * 通知の対象を見分けるための記録であり、セッション開始の成否には影響させない。
 *
 * @param {string} workspace
 * @param {object} [options]
 * @returns {string} 警告（無ければ空文字）
 */
function recordOrchestratorSession(workspace, options = {}) {
  const isStdinTTY = options.isStdinTTY || (() => process.stdin.isTTY);
  if (isStdinTTY()) return '';
  const readStdin = options.readStdinFn || (() => fs.readFileSync(0, 'utf8'));
  const mark = options.markSessionFn || markOrchestratorSession;
  try {
    const input = parseJsonText(readStdin());
    const sessionId = input && typeof input === 'object' ? input.session_id : undefined;
    if (typeof sessionId !== 'string' || sessionId === '') {
      return 'gh-maestro-session-hook: hook入力に session_id が無いため、orchestratorセッションを記録しませんでした（通知は送られません）\n';
    }
    mark(workspace, sessionId);
    return '';
  } catch (error) {
    return `gh-maestro-session-hook: orchestratorセッションを記録できませんでした（通知は送られません）: ${error.message}\n`;
  }
}

function printArgsError(error, writeStderr) {
  if (error && error.name === 'ArgsValidationError') {
    if (error.helpRequested) {
      return false;
    }
    for (const item of error.errors) writeStderr(`gh-maestro-session-hook: ${item.message}\n`);
    writeStderr(`${USAGE}\n`);
    return true;
  }
  throw error;
}

/**
 * CLI本体。戻り値をprocess.exitCodeへ設定するだけにし、require時の副作用を避ける。
 *
 * @param {string[]} [argv]
 * @param {object} [options]
 * @returns {number}
 */
function main(argv = process.argv.slice(2), options = {}) {
  const writeStdout = options.writeStdoutFn || ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderrFn || ((value) => process.stderr.write(value));

  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (error) {
    const handled = printArgsError(error, writeStderr);
    if (!handled) writeStdout(`${USAGE}\n`);
    return error && error.helpRequested ? 0 : 1;
  }

  if (values['--help'] || values['-h']) {
    writeStdout(`${USAGE}\n`);
    return 0;
  }

  // 明示された --workspace を最優先し、hookが配るCLAUDE_PROJECT_DIRを次に使う。
  // 明示値を resolveWorkspace に渡すことで、初回setup前に .gh-maestro/ が無いworkspace
  // でも解決でき、managed root / homeとの衝突検証も共有ヘルパーへ集約できる。
  const workspaceArg = values['--workspace'] ?? process.env.CLAUDE_PROJECT_DIR;
  const workspace = resolveWorkspace(workspaceArg);
  if (!workspace) {
    writeStderr(
      'gh-maestro-session-hook: ワークスペースを解決できません。'
      + '--workspace を指定するか、CLAUDE_PROJECT_DIR または .gh-maestro のある場所で実行してください。\n'
    );
    return 1;
  }

  const result = (options.runSessionHookFn || runSessionHook)(workspace, options);
  if (!result || result.ok !== true) {
    if (result) writeStderr(outputText(result.stderr));
    return result && Number.isInteger(result.exitCode) ? result.exitCode : 1;
  }

  // contextを含むstdoutは、全段階成功後にだけ出力する。
  writeStderr(outputText(result.stderr));
  writeStderr(recordOrchestratorSession(workspace, options));
  writeStdout(outputText(result.stdout));
  return 0;
}

module.exports = {
  USAGE,
  SPEC,
  stageDefinitions,
  runSessionHook,
  recordOrchestratorSession,
  main,
};

if (require.main === module) {
  process.exitCode = main();
}
