#!/usr/bin/env node
// update-issue.js — GitHub Issue本文更新の唯一の呼び出し口
//
// 呼び出し側は /tmp/... 等の論理パスだけを渡す。GitHub CLIはWindows上で
// Git Bashの論理パスを解決しないため、ここで実体パスへ変換してから渡す。
// 更新成功時だけbody-fileを削除し、失敗時は原案を残す。
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { toWinPath } = require('./win-path');

const USAGE = `update-issue.js — GitHub Issue本文を更新し、成功時にbody-fileを削除する

Usage:
  node update-issue.js --issue <N> --body-file <path> [--title <タイトル>] [--repo <owner/repo>] [--workspace <path>]

Options:
  --issue <N>           対象Issue番号（必須、正の整数）
  --body-file <path>    更新本文ファイルの論理パス（UTF-8）。成功時に削除される
  --title <タイトル>    Issueタイトル（省略時は変更しない）
  --repo <owner/repo>   対象リポジトリ（省略時はworkspaceから解決）
  --workspace <path>    ワークスペースのルートパス（省略時は環境変数またはCWDから解決）

Output (stdout):
  ISSUE_UPDATED:<番号>  更新成功

body-fileはこのスクリプトが論理パスから解決する。GitHub CLIが失敗した場合は保持される。`;

function defaultGhEdit({ issue, title, bodyFile, repo, workspace }, spawnFn = spawnSync) {
  const args = ['issue', 'edit', String(issue)];
  if (title !== undefined) args.push('--title', title);
  args.push('--body-file', bodyFile);
  if (repo) args.push('--repo', repo);
  return spawnFn('gh', args, { cwd: workspace, encoding: 'utf8' });
}

/**
 * Issue本文を更新する。
 *
 * @param {{issue: string|number, bodyFile: string, title?: string, repo?: string, workspace: string}} params
 *   bodyFileは解決済みの実体パス。
 * @param {{ghEditFn?: Function, unlinkBodyFileFn?: Function}} deps テスト用依存注入
 * @returns {{ok: boolean, status?: number, stdout?: string, stderr?: string}}
 */
function updateIssue({ issue, bodyFile, title, repo, workspace }, deps = {}) {
  const {
    ghEditFn = defaultGhEdit,
    unlinkBodyFileFn = (p) => fs.unlinkSync(p),
  } = deps;

  const result = ghEditFn({ issue, title, bodyFile, repo, workspace });
  if (result.status !== 0) {
    return { ok: false, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  }

  unlinkBodyFileFn(bodyFile);
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function main(argv = process.argv.slice(2), deps = {}) {
  let values;
  let rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: {
        '--issue': { required: true },
        '--body-file': { required: true },
        '--title': {},
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
    return { code: 1, stderr: `update-issue: --issue は正の整数で指定してください。\n${USAGE}` };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    return { code: 1, stderr: 'update-issue: ワークスペースを解決できません。--workspaceを指定するか、.gh-maestro/のあるディレクトリで実行してください。' };
  }

  const logicalBodyFile = values['--body-file'];
  const bodyFile = path.resolve(toWinPath(logicalBodyFile));
  try {
    fs.accessSync(bodyFile, fs.constants.F_OK);
  } catch {
    return { code: 1, stderr: `update-issue: body-fileが見つかりません: ${logicalBodyFile}` };
  }

  const result = updateIssue({
    issue,
    title: values['--title'],
    bodyFile,
    repo: values['--repo'],
    workspace,
  }, deps);

  if (!result.ok) {
    return {
      code: result.status || 1,
      stderr: `update-issue: gh issue editに失敗しました。body-fileは保持します: ${logicalBodyFile}\n${result.stderr}`,
    };
  }

  return { code: 0, stdout: `ISSUE_UPDATED:${issue}` };
}

if (require.main === module) {
  const result = main();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}

module.exports = { main, updateIssue, defaultGhEdit, USAGE };
