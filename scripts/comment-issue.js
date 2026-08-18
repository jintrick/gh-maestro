#!/usr/bin/env node
// comment-issue.js — GitHub Issueコメント投稿の唯一の呼び出し口
//
// 呼び出し側は /tmp/... 等の論理パスだけを渡す。GitHub CLIはWindows上で
// Git Bashの論理パスを解決しないため、ここで実体パスへ変換してから渡す。
// 投稿成功時だけbody-fileを削除し、失敗時は原案を残す。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { toWinPath } = require('./win-path');

const USAGE = `comment-issue.js — GitHub Issueへコメントを投稿し、成功時にbody-fileを削除する

Usage:
  node comment-issue.js --issue <N> --body-file <path> [--repo <owner/repo>] [--workspace <path>]

Options:
  --issue <N>           対象Issue番号（必須、正の整数）
  --body-file <path>    コメント本文ファイルの論理パス（UTF-8）。成功時に削除される
  --repo <owner/repo>   対象リポジトリ（省略時はworkspaceから解決）
  --workspace <path>    ワークスペースのルートパス（省略時は環境変数またはCWDから解決）

Output (stdout):
  投稿されたコメントのURLを1行出力

body-fileはこのスクリプトが論理パスから解決する。GitHub CLIが失敗した場合、またはURLを返さなかった場合は保持される。`;

function defaultGhComment({ issue, bodyFile, repo, workspace }, spawnFn = spawnSync) {
  const args = ['issue', 'comment', String(issue), '--body-file', bodyFile];
  if (repo) args.push('--repo', repo);
  return spawnFn('gh', args, { cwd: workspace, encoding: 'utf8' });
}

/**
 * Issueへコメントを投稿する。
 *
 * @param {{issue: string|number, bodyFile: string, repo?: string, workspace: string}} params
 *   bodyFileは解決済みの実体パス。
 * @param {{ghCommentFn?: Function, unlinkBodyFileFn?: Function}} deps テスト用依存注入
 * @returns {{ok: boolean, url?: string, status?: number, stdout?: string, stderr?: string}}
 */
function commentIssue({ issue, bodyFile, repo, workspace }, deps = {}) {
  const {
    ghCommentFn = defaultGhComment,
    unlinkBodyFileFn = (p) => fs.unlinkSync(p),
  } = deps;

  const result = ghCommentFn({ issue, bodyFile, repo, workspace });
  if (result.status !== 0) {
    return { ok: false, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  const url = (result.stdout || '').trim();
  if (!url) {
    return { ok: false, status: 1, stdout: result.stdout || '', stderr: 'コメント投稿は成功しましたがURLが返されませんでした。' };
  }

  unlinkBodyFileFn(bodyFile);
  return { ok: true, url, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function main(argv = process.argv.slice(2), deps = {}) {
  let values;
  let rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: {
        '--issue': { required: true },
        '--body-file': { required: true },
        '--repo': {},
        '--workspace': {},
      },
      booleans: ['--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { code: 0, stdout: USAGE };
    return { code: 1, stderr: `${err.errors.map((e) => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) return { code: 0, stdout: USAGE };

  const issue = values['--issue'];
  if (!/^[1-9]\d*$/.test(issue)) {
    return { code: 1, stderr: `comment-issue: --issue は正の整数で指定してください。\n${USAGE}` };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    return { code: 1, stderr: 'comment-issue: ワークスペースを解決できません。--workspaceを指定するか、.gh-maestro/のあるディレクトリで実行してください。' };
  }

  const logicalBodyFile = values['--body-file'];
  const bodyFile = path.resolve(toWinPath(logicalBodyFile));
  try {
    fs.accessSync(bodyFile, fs.constants.F_OK);
  } catch {
    return { code: 1, stderr: `comment-issue: body-fileが見つかりません: ${logicalBodyFile}` };
  }

  const result = commentIssue({
    issue,
    bodyFile,
    repo: values['--repo'],
    workspace,
  }, deps);

  if (!result.ok) {
    return {
      code: result.status || 1,
      stderr: `comment-issue: gh issue commentに失敗しました。body-fileは保持します: ${logicalBodyFile}\n${result.stderr}`,
    };
  }

  return { code: 0, stdout: result.url };
}

if (require.main === module) {
  const result = main();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}

module.exports = { main, commentIssue, defaultGhComment, USAGE };
