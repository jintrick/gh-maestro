#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./sync-rules');
const { parseFlags } = require('./shared/workspace');

const SPEC = {
  flags: { '--root': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: Infinity },
};

const USAGE = `find-matching-rules.js — ファイルパスにマッチする .claude/rules/*.md を検索する

Usage: node find-matching-rules.js [--root <path>] <file...>

Arguments:
  --root <path>    プロジェクトルートディレクトリ（省略時: CWD）
  <file...>        マッチ対象のファイルパス（ルートからの相対パス）

Output (stdout):
  マッチした .claude/rules/*.md のパスを1行ずつ出力（ルートからの相対パス）

Example:
  node find-matching-rules.js --root /path/to/project scripts/spawn-worker.js scripts/install.js`;

// ── glob to regex ────────────────────────────────────────────────────────────

/**
 * シンプルな glob パターンを正規表現に変換する。
 * - ** : 0文字以上の任意のパスセグメント（** / はディレクトリをまたぐ）
 * - *  : 1セグメント内の任意の文字（/ を含まない）
 * - その他: リテラル一致（正規表現の特殊文字はエスケープ）
 */
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // **: ディレクトリ境界をまたぐ任意マッチ
      if (i + 2 < pattern.length && pattern[i + 2] === '/') {
        // **/ — 0個以上のディレクトリセグメント
        re += '(?:.+/)?';
        i += 3;
      } else if (i + 2 >= pattern.length) {
        // 末尾の ** — 任意のパス全体
        re += '.*';
        i += 2;
      } else {
        // ** の直後が / 以外 — 安全のため .* 扱い
        re += '.*';
        i += 2;
      }
    } else if (pattern[i] === '*') {
      // * — 1セグメント内の任意文字（/ を含まない）
      re += '[^/]*';
      i++;
    } else if ('.^$+?=!{}()|[]\\'.includes(pattern[i])) {
      re += '\\' + pattern[i];
      i++;
    } else {
      re += pattern[i];
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * 指定されたファイルパスが glob パターンのいずれかにマッチするか判定する。
 * パス区切り文字は POSIX 形式（/）に正規化して比較する。
 */
function matchesAny(filePath, globs) {
  const normalized = filePath.replace(/\\/g, '/');
  for (const g of globs) {
    if (globToRegex(g).test(normalized)) return true;
  }
  return false;
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} root      プロジェクトルートの絶対パス
 * @param {string[]} files   マッチ対象のファイルパス
 * @returns {{ matched: string[], errors: string[] }}
 */
function findMatchingRules(root, files) {
  const rulesDir = path.join(root, '.claude', 'rules');
  const matched = [];
  const errors = [];

  if (!fs.existsSync(rulesDir)) {
    // ルールディレクトリがなければ空を返す（エラー終了しない）
    return { matched, errors };
  }

  let entries;
  try {
    entries = fs.readdirSync(rulesDir, { withFileTypes: true });
  } catch (e) {
    errors.push(`.claude/rules/ の読み取りに失敗しました: ${e.message}`);
    return { matched, errors };
  }

  const ruleFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md'));

  for (const entry of ruleFiles) {
    const rulePath = path.join(rulesDir, entry.name);
    let content;
    try {
      content = fs.readFileSync(rulePath, 'utf8');
    } catch (e) {
      errors.push(`${entry.name} の読み取りに失敗しました: ${e.message}`);
      continue;
    }

    const { paths: globs } = parseFrontmatter(content);
    if (!globs || globs.length === 0) continue;

    if (files.some(f => matchesAny(f, globs))) {
      matched.push('.claude/rules/' + entry.name);
    }
  }

  return { matched, errors };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`find-matching-rules: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    process.exit(0);
  }

  if (rest.length === 0) {
    console.error('find-matching-rules: ファイルパスを1つ以上指定してください');
    console.error(USAGE);
    process.exit(1);
  }

  const root = values['--root'] ? path.resolve(values['--root']) : process.cwd();

  const { matched, errors } = findMatchingRules(root, rest);

  if (errors.length > 0) {
    for (const err of errors) console.error(err);
  }

  for (const m of matched) console.log(m);

  process.exit(0);
}

module.exports = { globToRegex, matchesAny, findMatchingRules };
