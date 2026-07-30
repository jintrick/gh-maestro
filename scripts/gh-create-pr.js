'use strict';
// gh-create-pr.js
// gh pr create のラッパー。baseブランチをgit upstream trackingから自動解決する。
// コーダーが --base を明示的に指定できず、誤ったbaseブランチでPRが作成されるのを防止する。
//
// Usage:
//   node gh-create-pr.js --title <title> --body <body> [--repo <owner/repo>]
//   node gh-create-pr.js --title <title> --body-file <path> [--repo <owner/repo>]
//
// 標準出力: PR のURL（1行）
// 終了コード: 0=成功、1=エラー

const { spawnSync } = require('./child-process');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

const USAGE = `Usage:
  node gh-create-pr.js --title <title> --body <body> [--repo <owner/repo>]
  node gh-create-pr.js --title <title> --body-file <path> [--repo <owner/repo>]

Arguments:
  --title <title>           PRのタイトル（必須）
  --body <body>             PRの本文（--body-file と排他、いずれか必須）
  --body-file <path>        PR本文のファイルパス（--body と排他、いずれか必須）
  --repo <owner/repo>       リポジトリ指定（省略可、git remoteから自動検出）

baseブランチはカレントディレクトリのgit upstream trackingから自動解決されます。
--base フラグは受け付けません。

Output:
  PRのURLを標準出力に出力します。
  exit 0 = 成功、exit 1 = エラー`;

const VALUE_FLAGS = ['--title', '--body', '--body-file', '--repo'];
const BOOLEAN_FLAGS = [];

/**
 * カレントディレクトリのgit upstream trackingからbaseブランチを解決する。
 * @param {object} [opts]
 * @param {string} [opts.cwd] - 実行ディレクトリ（省略時はprocess.cwd()）
 * @returns {string} baseブランチ名（例: "dev"）。
 * @throws {Error} upstream未設定・gitエラー時
 */
function resolveBaseBranch(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0 || !r.stdout) {
    throw new Error('git upstream trackingが設定されていません。worktreeが正しく作成されているか確認してください。');
  }
  const upstream = r.stdout.trim();
  // "origin/dev" → "dev"
  if (!upstream.startsWith('origin/')) {
    throw new Error(`予期しないupstream形式です: ${upstream}（origin/<branch>形式を期待）`);
  }
  return upstream.slice('origin/'.length);
}

/**
 * gh pr create を実行する。
 * @param {object} opts
 * @param {string} opts.title - PRタイトル
 * @param {string} [opts.body] - PR本文（body-file と排他）
 * @param {string} [opts.bodyFile] - PR本文のファイルパス（body と排他）
 * @param {string} [opts.repo] - リポジトリ指定
 * @param {string} [opts.cwd] - 実行ディレクトリ
 * @returns {{ url: string, status: number }}
 */
function createPr(opts) {
  const baseBranch = resolveBaseBranch(opts);
  const args = ['pr', 'create', '--base', baseBranch, '--title', opts.title];
  if (opts.body) {
    args.push('--body', opts.body);
  } else if (opts.bodyFile) {
    args.push('--body-file', opts.bodyFile);
  }
  if (opts.repo) args.push('--repo', opts.repo);
  const r = spawnSync('gh', args, { cwd: opts.cwd, encoding: 'utf8' });
  return { url: (r.stdout || '').trim(), status: r.status, stderr: (r.stderr || '').trim() };
}

// ── CLI エントリポイント ─────────────────────────────────────────────────────

function main(argv) {
  const { values, rest, exitFlagMiss } = parseFlags(argv, VALUE_FLAGS, BOOLEAN_FLAGS);

  if (exitFlagMiss) {
    return { exitCode: 1, stderr: USAGE };
  }

  if (hasHelpFlag(rest)) {
    return { exitCode: 0, stdout: USAGE };
  }

  if (rest.length > 0) {
    return { exitCode: 1, stderr: `gh-create-pr: 未知の引数です: ${rest.join(' ')}\n${USAGE}` };
  }

  const title = values['--title'];
  const body = values['--body'];
  const bodyFile = values['--body-file'];
  const repo = values['--repo'];

  if (!title) {
    return { exitCode: 1, stderr: `gh-create-pr: --title が必要です\n${USAGE}` };
  }
  if (!body && !bodyFile) {
    return { exitCode: 1, stderr: `gh-create-pr: --body または --body-file が必要です\n${USAGE}` };
  }
  if (body && bodyFile) {
    return { exitCode: 1, stderr: `gh-create-pr: --body と --body-file は同時に指定できません\n${USAGE}` };
  }

  let result;
  try {
    result = createPr({ title, body, bodyFile, repo });
  } catch (e) {
    return { exitCode: 1, stderr: `gh-create-pr: エラー: ${e.message}` };
  }

  if (result.status !== 0) {
    return { exitCode: 1, stderr: `gh-create-pr: gh pr create 失敗:\n${result.stderr || '(no stderr)'}` };
  }

  return { exitCode: 0, stdout: result.url };
}

module.exports = { resolveBaseBranch, createPr, main, USAGE };

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
