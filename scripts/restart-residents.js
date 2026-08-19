#!/usr/bin/env node
'use strict';

// restart-residents.js — install後の常駐4種を一括で入れ替えるCLI。

const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { restartResidents, formatResidentResult } = require('./shared/restart-residents');

const USAGE = `restart-residents.js — 常駐プロセス4種を現行コードへ入れ替える

Usage:
  node restart-residents.js [--workspace <path>] [--session-pid <pid>]

Options:
  --workspace <path>  ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または
                      CWDからの .gh-maestro/ 上方探索で解決）
  --session-pid <pid> inbox-supervisorのregistry引数と対象プロセス親チェーンから
                      PIDを解決できない旧形式に限るフォールバック。
  --help, -h          このヘルプを表示する

対象:
  inbox-supervisor.js / msg-poll.js（orchestrator）/ poll-pr.js / poll-reviews.js

Output (stdout):
  RESIDENT script=<name> status=replaced|monitor-required|delegated|not-running|failed ...
  MONITOR_REATTACH_REQUIRED script=<name> command=<command>
  Monitorで出力を受ける常駐は停止後にdetached起動せず、上記の再接続指示を必ず実行する。
  poll-pr.js が poll-reviews.js を子として起動する構成では、後者は delegated と出力する。

副作用:
  PIDと起動時刻の同一性を確認できた対象だけを停止する。inbox-supervisorは現行
  scripts/ 配下からdetached起動し、Monitor常駐3種はMonitorからの再接続を要求する。
  inbox-supervisorの起動ログは <workspace>/.gh-maestro/resident-restart-logs/ に追記する。
  registryの読み取り・停止・起動確認に失敗した場合は、未確認のプロセスを削除せず終了コード1を返す。`;

function parsePositivePid(value) {
  if (value === undefined) return undefined;
  const pid = Number.parseInt(value, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * CLIを実行する。
 *
 * @param {string[]} [argv]
 * @param {object} [opts] テスト用依存注入
 * @returns {{code:number, lines:string[], errLines:string[]}}
 */
function main(argv = process.argv.slice(2), opts = {}) {
  const lines = [];
  const errLines = [];
  let values;
  try {
    ({ values } = parseFlags(argv, {
      flags: { '--workspace': {}, '--session-pid': {} },
      booleans: ['--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { code: 0, lines: [USAGE], errLines: [] };
    for (const item of err.errors) errLines.push(`restart-residents: ${item.message}`);
    errLines.push(USAGE);
    return { code: 1, lines, errLines };
  }

  if (values['--help'] || values['-h']) return { code: 0, lines: [USAGE], errLines };

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    errLines.push('restart-residents: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines, errLines };
  }

  const fallbackSessionPid = parsePositivePid(values['--session-pid']);
  if (fallbackSessionPid === null) {
    errLines.push('restart-residents: --session-pid は正の整数で指定してください');
    return { code: 1, lines, errLines };
  }

  let result;
  try {
    result = restartResidents(workspace, {
      scriptsPath: opts.scriptsPath || __dirname,
      fallbackSessionPid,
      hooks: opts.hooks,
      maxAttempts: opts.maxAttempts,
      waitMs: opts.waitMs,
    });
  } catch (e) {
    errLines.push(`restart-residents: ${e.message}`);
    return { code: 1, lines, errLines };
  }

  for (const resident of result.results) {
    lines.push(formatResidentResult(resident));
    const monitorCommands = resident.commands || [];
    if (resident.monitorRequired) {
      for (const command of monitorCommands) {
        lines.push(`MONITOR_REATTACH_REQUIRED script=${resident.monitorScript || resident.script} command=${command}`);
      }
    }
  }
  for (const error of result.errors) errLines.push(`restart-residents: ${error}`);

  return { code: result.errors.length > 0 ? 1 : 0, lines, errLines };
}

function writeResult(result, stdout = process.stdout, stderr = process.stderr) {
  for (const line of result.errLines) stderr.write(line + '\n');
  for (const line of result.lines) stdout.write(line + '\n');
  return result.code;
}

module.exports = { main, USAGE, parsePositivePid, writeResult };

if (require.main === module) {
  const result = main();
  process.exitCode = writeResult(result);
}
