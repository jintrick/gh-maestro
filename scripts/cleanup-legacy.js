#!/usr/bin/env node
'use strict';

// cleanup-legacy.js — 台帳に登録されたレガシー遺物を明示的に整理するCLI。
//
// check-legacy.jsの検出とは連鎖させず、cleanupIdを明示した呼び出しだけが
// 対応する整理処理を実行する。

const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { cleanupLegacyArtifact } = require('./shared/legacy-cleanup');

const USAGE = [
  'cleanup-legacy.js — 台帳に登録されたレガシー遺物を明示的に整理する',
  '',
  'Usage:',
  '  node cleanup-legacy.js --cleanup-id <cleanupId> [--workspace <path>]',
  '',
  'Options:',
  '  --cleanup-id <id>  legacy-catalog.jsonに登録されたcleanupId',
  '  --workspace <path> 対象プロジェクトのルート（省略時は',
  '                     GH_MAESTRO_WORKSPACE または CWD から解決）',
  '  --help, -h         このusageを表示',
  '',
  'status-paneの旧形式を整理する場合、旧記録のファイルだけを削除し、',
  '記録中のpaneIdを使ったWezTermの照会・終了は行わない。現行形式や破損した',
  '記録は削除せず、判定不能な場合は終了コード1で返す。',
].join('\n');

const SPEC = {
  flags: {
    '--cleanup-id': { required: true },
    '--workspace': {},
  },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

function writeUsage(writeStdout) {
  writeStdout(USAGE + '\n');
}

function main(argv = process.argv.slice(2), options = {}) {
  const writeStdout = options.writeStdoutFn || ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderrFn || ((value) => process.stderr.write(value));
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error && error.name === 'ArgsValidationError') {
      if (error.helpRequested) {
        writeUsage(writeStdout);
        return 0;
      }
      for (const item of error.errors) writeStderr('cleanup-legacy: ' + item.message + '\n');
      writeUsage(writeStderr);
      return 1;
    }
    throw error;
  }

  if (values['--help'] || values['-h']) {
    writeUsage(writeStdout);
    return 0;
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeStderr(
      'cleanup-legacy: ワークスペースを解決できません。--workspace を指定するか、'
      + 'GH_MAESTRO_WORKSPACE または .gh-maestro のあるディレクトリで実行してください。\n',
    );
    return 1;
  }

  let result;
  try {
    result = (options.cleanupFn || cleanupLegacyArtifact)({
      cleanupId: values['--cleanup-id'],
      workspace,
    });
  } catch (error) {
    writeStderr('cleanup-legacy: 片付けを実行できません: ' + error.message + '\n');
    return 1;
  }

  writeStdout(JSON.stringify({
    cleanupId: values['--cleanup-id'],
    workspace,
    ...result,
  }, null, 2) + '\n');
  return result && result.ok === true ? 0 : 1;
}

module.exports = { USAGE, SPEC, main };

if (require.main === module) process.exitCode = main();
