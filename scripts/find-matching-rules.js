#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./sync-rules');
const { parseFlags } = require('./shared/workspace');
const { spawnSync } = require('./shared/child-process');
const { readFileAtRef, parseTreeEntries, normalizeGitPath } = require('./shared/git-ref');

const SPEC = {
  flags: { '--root': {}, '--ref': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: Infinity },
};

const USAGE = `find-matching-rules.js — ファイルパスにマッチする .claude/rules/**/*.md を検索する

Usage: node find-matching-rules.js [--root <path>] [--ref <ref>] <file...>

Arguments:
  --root <path>    プロジェクトルートディレクトリ（省略時: CWD）
  --ref <ref>      作業ツリーではなく指定 Git ref/commit の .claude/rules/ を読む
  <file...>        マッチ対象のファイルパス（ルートからの相対パス）

Output (stdout):
  マッチした .claude/rules/**/*.md のパスを1行ずつ出力（ルートからの相対パス）
  終了コード: 0（正常終了、0件マッチ・.claude/rules/不在を含む）/ 1（引数不正・取得/読取失敗）

Example:
  node find-matching-rules.js --root /path/to/project scripts/spawn-worker.js scripts/install.js
  node find-matching-rules.js --ref origin/dev scripts/spawn-worker.js`;

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
  const normalized = normalizeGitPath(filePath);
  for (const g of globs) {
    if (globToRegex(g).test(normalized)) return true;
  }
  return false;
}

function matchesRuleContent(content, files) {
  const { paths: globs } = parseFrontmatter(content);
  if (!globs || globs.length === 0) return false;
  return files.some(f => matchesAny(f, globs));
}

function runGit(root, args, spawnSyncFn) {
  let result;
  try {
    result = spawnSyncFn('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!result || result.error || result.status === null || result.status === undefined) {
    return {
      ok: false,
      error: result?.error?.message || 'git process did not provide an exit status',
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: String(result.stderr || '').trim() || `exit code ${result.status}`,
    };
  }
  return { ok: true, stdout: String(result.stdout || '') };
}

// ── main ─────────────────────────────────────────────────────────────────────

/**
 * 作業ツリーの .claude/rules/ 配下の .md ファイルからマッチするルールを検索する。
 *
 * @param {string} root
 * @param {string[]} files
 * @returns {{ matched: string[], errors: string[] }}
 */
function findMatchingRulesFromTree(root, files) {
  const rulesDir = path.join(root, '.claude', 'rules');
  const matched = [];
  const errors = [];

  if (!fs.existsSync(rulesDir)) {
    // ルールディレクトリがなければ空を返す（エラー終了しない）
    return { matched, errors };
  }

  let entries;
  try {
    entries = fs.readdirSync(rulesDir, { recursive: true, withFileTypes: true });
  } catch (e) {
    errors.push(`.claude/rules/ の読み取りに失敗しました: ${e.message}`);
    return { matched, errors };
  }

  const ruleFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => {
      const fullPath = path.join(e.parentPath || e.path, e.name);
      const relFromRules = normalizeGitPath(path.relative(rulesDir, fullPath));
      return { fullPath, relPath: `.claude/rules/${relFromRules}` };
    })
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  for (const { fullPath, relPath } of ruleFiles) {
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      errors.push(`${relPath} の読み取りに失敗しました: ${e.message}`);
      continue;
    }

    if (matchesRuleContent(content, files)) {
      matched.push(relPath);
    }
  }

  return { matched: errors.length > 0 ? [] : matched, errors };
}

/**
 * 指定 Git ref/commit の .claude/rules/** からマッチするルールを検索する。
 *
 * @param {string} root
 * @param {string} ref
 * @param {string[]} files
 * @param {{ spawnSyncFn?: Function }} [options]
 * @returns {{ matched: string[], errors: string[] }}
 */
function findMatchingRulesAtRef(root, ref, files, { spawnSyncFn = spawnSync } = {}) {
  const matched = [];
  const errors = [];

  if (typeof ref !== 'string') {
    errors.push('--ref には文字列の Git ref/commit を指定してください');
    return { matched, errors };
  }

  const revResult = runGit(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], spawnSyncFn);
  if (!revResult.ok) {
    errors.push(`--ref (${ref}) を解決できません: ${revResult.error}`);
    return { matched, errors };
  }
  const commitOid = revResult.stdout.trim();
  if (!commitOid) {
    errors.push(`--ref (${ref}) の解決結果が空です`);
    return { matched, errors };
  }

  const lsResult = runGit(
    root,
    ['ls-tree', '-r', '-z', '--end-of-options', commitOid, '--', '.claude/rules/'],
    spawnSyncFn,
  );
  if (!lsResult.ok) {
    errors.push(`git ls-tree (${commitOid}) に失敗しました: ${lsResult.error}`);
    return { matched, errors };
  }

  let entries;
  try {
    entries = parseTreeEntries(lsResult.stdout);
  } catch (e) {
    errors.push(e.message);
    return { matched, errors };
  }

  // 通常ファイルの .md のみ対象（シンボリックリンク 120000 やサブモジュールは除外）
  const ruleEntries = entries
    .filter(e => e.type === 'blob' && e.mode !== '120000' && e.path.endsWith('.md'))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const entry of ruleEntries) {
    const fileRes = readFileAtRef(root, commitOid, entry.path, { spawnSyncFn });
    if (fileRes.status !== 'present') {
      errors.push(fileRes.reason || `${commitOid}:${entry.path} の読み取りに失敗しました`);
      continue;
    }
    if (matchesRuleContent(fileRes.content, files)) {
      matched.push(entry.path);
    }
  }

  return { matched: errors.length > 0 ? [] : matched, errors };
}

/**
 * @param {string} root      プロジェクトルートの絶対パス
 * @param {string[]} files   マッチ対象のファイルパス
 * @param {{ ref?: string, spawnSyncFn?: Function }} [options]
 * @returns {{ matched: string[], errors: string[] }}
 */
function findMatchingRules(root, files, options = {}) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'ref') && options.ref !== undefined) {
    return findMatchingRulesAtRef(root, options.ref, files, options);
  }
  return findMatchingRulesFromTree(root, files);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(argv = process.argv.slice(2), options = {}) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      return { exitCode: 0, stdout: USAGE, stderr: '' };
    }
    const messages = err.errors.map(e => `find-matching-rules: ${e.message}`);
    return { exitCode: 1, stdout: '', stderr: `${messages.join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) {
    return { exitCode: 0, stdout: USAGE, stderr: '' };
  }

  if (rest.length === 0) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `find-matching-rules: ファイルパスを1つ以上指定してください\n${USAGE}`,
    };
  }

  const root = values['--root'] ? path.resolve(values['--root']) : (options.cwd || process.cwd());
  const findOptions = Object.prototype.hasOwnProperty.call(values, '--ref')
    ? { ref: values['--ref'], spawnSyncFn: options.spawnSyncFn }
    : { spawnSyncFn: options.spawnSyncFn };

  const { matched, errors } = findMatchingRules(root, rest, findOptions);

  if (errors.length > 0) {
    return { exitCode: 1, stdout: '', stderr: errors.join('\n') };
  }

  return { exitCode: 0, stdout: matched.join('\n'), stderr: '' };
}

if (require.main === module) {
  const result = main();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}

module.exports = {
  USAGE,
  globToRegex,
  matchesAny,
  findMatchingRules,
  findMatchingRulesAtRef,
  main,
};
