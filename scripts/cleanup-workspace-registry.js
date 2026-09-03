#!/usr/bin/env node
'use strict';

// cleanup-workspace-registry.js — runtime rootに残った、存在しないworkspaceの
// 常駐registryを削除する手動メンテナンスCLI。
//
// workspaceの実体が現存する登録は保護し、storage-layout.jsが検証した対応registry
// ディレクトリだけを対象にする。実行前に対象workspaceの存在確認を完了するため、
// registryの読み取りや存在確認が失敗した場合は削除を開始しない。

const { parseFlags } = require('./shared/workspace');
const storageLayout = require('./shared/storage-layout');

const USAGE = `cleanup-workspace-registry.js — 存在しないworkspaceのruntime registryを掃除する

Usage:
  node cleanup-workspace-registry.js [--dry-run]

Options:
  --dry-run              削除せず、staleなworkspace registryだけを表示する
  --help, -h             このヘルプを表示する

対象:
  runtime root（GH_MAESTRO_RUNTIME_DIR またはOS既定値）配下の workspaces/ にある
  workspace.json のうち、manifestの canonicalPath が現存ディレクトリでない登録。
  現存するworkspaceの登録は削除しない。registryの読み取り・検証・削除対象の安全確認に
  失敗した場合は終了コード1で中断する。`;

/**
 * CLIを実行する。
 *
 * @param {string[]} [argv]
 * @param {object} [options] テスト用依存注入
 * @param {Function} [options.removeStaleWorkspaceRegistrations]
 * @returns {{code:number, lines:string[], errLines:string[]}}
 */
function main(argv = process.argv.slice(2), options = {}) {
  const lines = [];
  const errLines = [];
  let values;
  try {
    ({ values } = parseFlags(argv, {
      flags: {},
      booleans: ['--dry-run', '--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) return { code: 0, lines: [USAGE], errLines: [] };
    for (const item of error.errors) errLines.push(`cleanup-workspace-registry: ${item.message}`);
    errLines.push(USAGE);
    return { code: 1, lines, errLines };
  }

  if (values['--help'] || values['-h']) return { code: 0, lines: [USAGE], errLines };

  const cleanup = options.removeStaleWorkspaceRegistrations
    || storageLayout.removeStaleWorkspaceRegistrations;
  if (typeof cleanup !== 'function') {
    return {
      code: 1,
      lines,
      errLines: ['cleanup-workspace-registry: cleanup関数が不正です'],
    };
  }

  let result;
  try {
    result = cleanup({ dryRun: values['--dry-run'] === true });
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return {
      code: 1,
      lines,
      errLines: [`cleanup-workspace-registry: ${detail}`],
    };
  }

  if (values['--dry-run']) {
    lines.push('[dry-run] workspace registryは変更していません');
  }
  if (result.removed.length > 0) {
    lines.push(`${values['--dry-run'] ? 'Stale workspace registrations' : 'Removed stale workspace registrations'} (${result.removed.length}):`);
    for (const entry of result.removed) {
      lines.push(`  workspace=${entry.workspace}`);
    }
  } else {
    lines.push('No stale workspace registrations found.');
  }

  return { code: 0, lines, errLines };
}

function writeResult(result, stdout = process.stdout, stderr = process.stderr) {
  for (const line of result.errLines) stderr.write(line + '\n');
  for (const line of result.lines) stdout.write(line + '\n');
  return result.code;
}

module.exports = { main, USAGE, writeResult };

if (require.main === module) {
  const result = main();
  process.exitCode = writeResult(result);
}
