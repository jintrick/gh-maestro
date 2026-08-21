#!/usr/bin/env node
'use strict';

// print-review-leaves.js — 配布済み正本のレビュー観点定義を標準出力へ出力する。
//
// 観点の集合とファイル名は review-aspects.js の正規定義から導出する。
// このCLI自身は内容の解釈や観点の選別を行わず、読み取った定義をそのまま返す。

const fs = require('fs');
const path = require('path');
const { parseFlags } = require('./shared/workspace');
const { managedRoot } = require('./shared/storage-layout');
const { ALL_LEAF_IDS, reviewFilesForLeaves } = require('./shared/review-aspects');

const USAGE = `print-review-leaves.js — 正本のレビュー観点定義を標準出力へ出力する

Usage:
  node print-review-leaves.js

Options:
  --help, -h    このUsageを表示する

Output:
  成功時、共通定義と7葉のレビュー観点定義を導出順に標準出力へ出力する
  終了コード0: 全定義ファイルの読み取りに成功
  終了コード1: 引数不正または定義ファイルの読み取り失敗`;

const SPEC = {
  flags: {},
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

/**
 * インストール済みのレビュー観点正本ディレクトリを返す。
 * @returns {string}
 */
function resolveReviewSkillsDir() {
  return path.join(managedRoot(), 'skills', 'gh-maestro-reviewer');
}

/**
 * 正本ルートから全レビュー観点定義を導出順に読み取る。
 * 全ファイルの読み取りが完了するまで結合しないため、途中までの不完全な定義を
 * 成功出力として返さない。
 *
 * @param {string} [reviewSkillsDir] テスト用の正本ルート差し替え
 * @returns {string} 読み取ったファイル内容の連結結果
 * @throws {Error} 正本ファイルを読み取れない場合
 */
function readReviewDefinitions(reviewSkillsDir = resolveReviewSkillsDir()) {
  const root = path.resolve(reviewSkillsDir);
  const relativePaths = reviewFilesForLeaves(ALL_LEAF_IDS);
  const contents = relativePaths.map((relativePath) => {
    const resolvedPath = path.resolve(root, relativePath);
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolvedPath !== root && !resolvedPath.startsWith(rootPrefix)) {
      throw new Error(`review definition path escapes canonical root: ${relativePath}`);
    }

    try {
      return fs.readFileSync(resolvedPath, 'utf8');
    } catch (error) {
      throw new Error(`cannot read review definition ${relativePath}: ${error.message}`, { cause: error });
    }
  });

  return contents.join('');
}

/**
 * CLIの引数を検証し、標準出力・標準エラー・終了コードを結果として返す。
 * @param {string[]} argv
 * @param {{ reviewSkillsDir?: string }} [options]
 * @returns {{exitCode: number, stdout?: string, stderr?: string}}
 */
function main(argv, options = {}) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) {
      return { exitCode: 0, stdout: USAGE };
    }
    return {
      exitCode: 1,
      stderr: `print-review-leaves: ${error.errors.map(e => e.message).join('\n')}\n${USAGE}`,
    };
  }

  if (values['--help'] || values['-h']) {
    return { exitCode: 0, stdout: USAGE };
  }

  try {
    return {
      exitCode: 0,
      stdout: readReviewDefinitions(options.reviewSkillsDir),
    };
  } catch (error) {
    return { exitCode: 1, stderr: `print-review-leaves: ${error.message}` };
  }
}

module.exports = {
  USAGE,
  SPEC,
  resolveReviewSkillsDir,
  readReviewDefinitions,
  main,
};

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  if (result.stderr !== undefined) process.stderr.write(`${result.stderr}\n`);
  process.exit(result.exitCode);
}
