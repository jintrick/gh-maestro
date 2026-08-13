#!/usr/bin/env node
// set-response-contract.js — orchestratorが応答契約を設定するCLI
//
// 責務:
//   orchestratorがコーダー/シニアコーダーの計画を承認し実装フェーズに進める際に、
//   応答契約（artifact-or-message）を設定する。これにより、実装完了後に
//   msg-send.jsが呼ばれなくてもPR作成をもって完了とみなされ、
//   誤った自動代理送信が発生しなくなる。
//
// Usage:
//   node set-response-contract.js --issue <N> --skill <role> --type artifact-or-message \
//       --artifact pr --workspace <path>
//
//   契約解除（既定値に戻す。通常は不要——契約は配送の終着点で自動的に消費されるため）:
//   node set-response-contract.js --issue <N> --skill <role> --type message-required --workspace <path>
//
// Output (stdout):
//   設定した契約の要約を1行出力

'use strict';

const { resolveWorkerName } = require('./shared/workers-registry');
const { resolveWorkspace, parseFlags, hasGenuineHelpRequest } = require('./shared/workspace');
const { CONTRACT_TYPES, writeContract, clearContract } = require('./shared/response-contract');

const SPEC = {
  flags: { '--issue': {}, '--skill': {}, '--type': {}, '--artifact': {}, '--workspace': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

const USAGE = `set-response-contract.js — orchestratorが応答契約を設定する

Usage:
  node set-response-contract.js --issue <N> --skill <role> --type <type> [--artifact <name>] [--workspace <path>]

Arguments:
  --issue <N>            対象のIssue番号（必須）
  --skill <role>         ワーカー役割（必須。gh-maestro-coder / gh-maestro-senior-coder 等）
  --type <type>          契約型（必須）:
                           message-required      — メッセージ送信のみで充足（既定）
                           artifact-or-message   — 指定成果物の成立またはメッセージ送信で充足
  --artifact <name>      artifact-or-message 時の成果物種別（現在は "pr" のみ対応）
  --workspace <path>     ワークスペースパス（省略時は環境変数またはCWDから解決）

Output (stdout):
  設定した契約の要約を1行出力。例:
    CONTRACT_SET:issue-5-coder-implement -> artifact-or-message(pr)

Description:
  orchestratorがコーダー/シニアコーダーの計画を承認し実装フェーズに進める際に、
  msg-send.js で承認指示を送る前にこのスクリプトで応答契約を設定する。
  契約は inbox-supervisor.js が resume 時に読み取り、設定された完了シグナル
  （メッセージ送信 または PR作成）に基づいて代理送信の要否を判定する。`;

function main(argsOverride) {
  const out = [];
  const err = [];

  const writeOut = (s) => out.push(s);
  const writeErr = (s) => err.push(s);

  const args = argsOverride || process.argv.slice(2);

  let values, rest;
  try {
    ({ values, rest } = parseFlags(args, SPEC));
  } catch (e) {
    if (e.name !== 'ArgsValidationError') throw e;
    if (hasGenuineHelpRequest(args, e.errors)) {
      writeOut(USAGE);
      return { code: 0, lines: out, errLines: err };
    }
    for (const ve of e.errors) writeErr(`set-response-contract: ${ve.message}`);
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (values['--help'] || values['-h']) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const issue = values['--issue'];
  const skill = values['--skill'];
  const type = values['--type'];
  const artifact = values['--artifact'];
  const workspace = resolveWorkspace(values['--workspace']);

  if (!issue) {
    writeErr('set-response-contract: --issue が必要です。');
    return { code: 1, lines: out, errLines: err };
  }
  if (!skill) {
    writeErr('set-response-contract: --skill が必要です。');
    return { code: 1, lines: out, errLines: err };
  }
  if (!type) {
    writeErr('set-response-contract: --type が必要です。');
    return { code: 1, lines: out, errLines: err };
  }
  if (!workspace) {
    writeErr('set-response-contract: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err };
  }

  // 契約型のバリデーション
  if (type !== CONTRACT_TYPES.MESSAGE_REQUIRED && type !== CONTRACT_TYPES.ARTIFACT_OR_MESSAGE) {
    writeErr(`set-response-contract: 未知の契約型です: "${type}"。${CONTRACT_TYPES.MESSAGE_REQUIRED} または ${CONTRACT_TYPES.ARTIFACT_OR_MESSAGE} を指定してください。`);
    return { code: 1, lines: out, errLines: err };
  }

  // artifact-or-message の場合は artifact も必須
  if (type === CONTRACT_TYPES.ARTIFACT_OR_MESSAGE && !artifact) {
    writeErr(`set-response-contract: --type ${CONTRACT_TYPES.ARTIFACT_OR_MESSAGE} の場合は --artifact が必要です（現在は "pr" のみ対応）。`);
    return { code: 1, lines: out, errLines: err };
  }

  // artifact のバリデーション
  if (artifact && artifact !== 'pr') {
    writeErr(`set-response-contract: 未知の成果物種別です: "${artifact}"。現在対応しているのは "pr" のみです。`);
    return { code: 1, lines: out, errLines: err };
  }

  // workerName を解決
  let workerName;
  try {
    workerName = resolveWorkerName(workspace, { issue, skill });
  } catch (e) {
    writeErr(`set-response-contract: ワーカーを解決できません: ${e.message}`);
    return { code: 1, lines: out, errLines: err };
  }

  // message-required は契約の削除と同じ
  if (type === CONTRACT_TYPES.MESSAGE_REQUIRED) {
    clearContract(workspace, workerName);
    writeOut(`CONTRACT_CLEARED:${workerName}`);
    return { code: 0, lines: out, errLines: err };
  }

  // artifact-or-message 契約を書き込み
  const contract = { type, artifact, issue: parseInt(issue, 10) };
  writeContract(workspace, workerName, contract);
  writeOut(`CONTRACT_SET:${workerName} -> ${type}(${artifact})`);

  return { code: 0, lines: out, errLines: err };
}

module.exports = { main, USAGE };

if (require.main === module) {
  const { code, lines, errLines } = main();
  for (const l of errLines) process.stderr.write(l + '\n');
  for (const l of lines) process.stdout.write(l + '\n');
  process.exit(code);
}
