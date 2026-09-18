#!/usr/bin/env node
'use strict';

const { ESLint } = require('eslint');

const TARGETS = Object.freeze(['scripts/**/*.js', 'tests/**/*.js']);
const USAGE = `run-lint.js — scripts/**/*.js と tests/**/*.js を静的検査する

Usage:
  node scripts/run-lint.js [--format <formatter>]

Options:
  --format <formatter>  ESLint formatter（既定: stylish。申告経路はjsonを使用）
  --help, -h             このヘルプを表示する

動作:
  lint指摘の有無では終了コードを変えず、指摘を標準出力へ出力する。設定の読み込みや
  lint実行自体に失敗した場合だけ終了コード1になる。対象ファイルのコードは実行しない。`;

function parseArgs(argv) {
  let format = process.env.GH_MAESTRO_LINT_FORMAT || 'stylish';
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') return { help: true, format };
    if (value === '--format') {
      const next = argv[index + 1];
      if (!next || next.startsWith('-')) throw new Error('--format には値が必要です');
      format = next;
      index += 1;
      continue;
    }
    throw new Error(`未知の引数です: ${value}`);
  }
  return { help: false, format };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${error.message}\n${USAGE}` };
  }
  if (options.help) return { exitCode: 0, stdout: USAGE, stderr: '' };

  try {
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles([...TARGETS]);
    const formatter = await eslint.loadFormatter(options.format);
    return { exitCode: 0, stdout: formatter.format(results), stderr: '' };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `lintの実行に失敗しました: ${error.message}` };
  }
}

module.exports = { TARGETS, USAGE, parseArgs, main };

if (require.main === module) {
  main().then((result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  });
}
