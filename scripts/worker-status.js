#!/usr/bin/env node
// worker-status.js — ワーカーの生死を照会するCLI
//
// workers.json の指定エントリを既存の worker-liveness 述語へ渡し、
// ワーカー本体が現在稼働中かを読み取り専用で返す。常駐プロセスのPID registryとは
// 別の仕組みであり、workers.json に記録されたワーカープロセスだけを対象にする。

'use strict';

const { normalizeWorkerEntry } = require('./shared/worker-entry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { readWorkersRaw } = require('./shared/workers-registry');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');

const CLI_USAGE = `worker-status.js — ワーカーの生死確認

Usage:
  node worker-status.js status --workspace <path> --worker-name <name>

Options:
  --workspace <path>     ワークスペースパス（必須）
  --worker-name <name>   生死を照会するワーカー名（必須）
  --help, -h             このヘルプを表示する

Output (stdout):
  {"workerName":...,"running":true|false,"pid":...}

Description:
  workers.json の指定ワーカーを読み取り、既存の isWorkerAlive で生死を判定する。
  対象ワーカーが未登録、PIDが停止中、または生死判定が false の場合も、照会成功として
  running:false・終了コード0を返す。workspaceの解決失敗や workers.json の読み取り・
  解析失敗、引数の誤用は終了コード1を返し、状態JSONは出力しない。`;

/**
 * worker-status CLIを実行する。
 *
 * @param {string[]} [argv] process.argv.slice(2) 相当
 * @returns {{code: number, lines: string[], errLines: string[]}}
 */
function main(argv = process.argv.slice(2)) {
  const out = [];
  const err = [];
  const writeOut = (line) => out.push(line);
  const writeErr = (line) => err.push(line);

  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--workspace': {}, '--worker-name': {} },
      booleans: ['--help', '-h'],
      // サブコマンドはちょうど1つ。未知フラグ・余剰位置引数はパーサ側で拒否する。
      positionals: { min: 1, max: 1 },
    }));
  } catch (parseError) {
    if (parseError.name !== 'ArgsValidationError') throw parseError;
    if (parseError.helpRequested) {
      writeOut(CLI_USAGE);
      return { code: 0, lines: out, errLines: [] };
    }
    for (const e of parseError.errors) writeErr(`worker-status: ${e.message}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (values['--help'] || values['-h']) {
    writeOut(CLI_USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  if (rest[0] !== 'status') {
    writeErr(`worker-status: 未知のサブコマンドです: ${rest[0]}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (!values['--workspace']) {
    writeErr('worker-status: --workspace が必要です');
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }
  if (!values['--worker-name']) {
    writeErr('worker-status: status には --worker-name が必要です');
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('worker-status: ワークスペースを解決できません');
    return { code: 1, lines: out, errLines: err };
  }

  const workerName = values['--worker-name'];
  let rawWorkers;
  try {
    rawWorkers = readWorkersRaw(workspace);
  } catch (e) {
    writeErr(`worker-status: status の照会に失敗しました: ${e.message}`);
    return { code: 1, lines: out, errLines: err };
  }

  const rawEntry = rawWorkers && Object.prototype.hasOwnProperty.call(rawWorkers, workerName)
    ? rawWorkers[workerName]
    : undefined;
  const entry = normalizeWorkerEntry(rawEntry);

  writeOut(JSON.stringify({
    workerName,
    running: isWorkerAlive(rawEntry),
    pid: entry.pid,
  }));
  return { code: 0, lines: out, errLines: err };
}

module.exports = { main, CLI_USAGE };

if (require.main === module) {
  const result = main();
  for (const line of result.errLines) process.stderr.write(line + '\n');
  for (const line of result.lines) process.stdout.write(line + '\n');
  process.exit(result.code);
}
