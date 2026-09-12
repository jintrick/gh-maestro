#!/usr/bin/env node
'use strict';

const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { inspectLegacyArtifacts, hasLegacyFindings } = require('./shared/legacy-catalog');

const USAGE = `check-legacy.js — 既知のレガシー遺物を非破壊で検査する

Usage: node check-legacy.js [--workspace <path>]

Options:
  --workspace <path>  対象プロジェクトのルート（省略時は
                      GH_MAESTRO_WORKSPACE または CWD から解決）
  --help, -h          このusageを表示

遺物の検査はファイル・fetch済みGit ref・プロセス状態の読み取りだけを行い、
削除・移行・プロセス停止・ネットワーク通信は行わない。検査自体が成功した場合、
遺物の存在や判定不能は終了コード0で、検査を実行できない場合だけ終了コード1で返す。`;

const SPEC = {
  flags: { '--workspace': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

function writeUsage(writeStdout) {
  writeStdout(`${USAGE}\n`);
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
      for (const item of error.errors) writeStderr(`check-legacy: ${item.message}\n`);
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
      'check-legacy: ワークスペースを解決できません。--workspace を指定するか、'
      + 'GH_MAESTRO_WORKSPACE または .gh-maestro のあるディレクトリで実行してください。\n',
    );
    return 1;
  }

  let result;
  try {
    result = (options.inspectFn || inspectLegacyArtifacts)({ workspace });
  } catch (error) {
    writeStderr(`check-legacy: 検査を実行できません: ${error.message}\n`);
    return 1;
  }

  if (hasLegacyFindings(result)) writeStdout(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

module.exports = { USAGE, SPEC, main };

if (require.main === module) process.exitCode = main();
