#!/usr/bin/env node
// create-issue.js
// gh issue create の唯一の呼び出し口。作成成功後に --body-file を必ず削除する。
// tmp/issue-draft.md を使い回すと、次回起票時に「既存ファイルだから読み直す」という
// 無駄なReadが発生する。削除をスクリプト側の必須処理にすることで、
// orchestrator（LLM）の記憶に依存せず毎回クリーンな状態を保証する。
'use strict';

const { spawnSync } = require('./child-process');
const fs = require('fs');
const path = require('path');
const { toWinPath } = require('./win-path');

const USAGE = `create-issue.js — GitHub Issue を作成し、body-file を必ず削除する

Usage: node create-issue.js --title <タイトル> --body-file <path> [--repo <owner/repo>]

Arguments:
  --title <タイトル>     Issue タイトル
  --body-file <path>    Issue本文ファイル（/tmp 形式可）。作成成功後に削除される
  --repo <owner/repo>   対象リポジトリ（省略時はカレントディレクトリのリポジトリ）

Output (stdout):
  ISSUE_CREATED:<番号>  作成成功。<URL> も併記される

body-file は常にこのスクリプトが削除する。呼び出し側は削除を意識しなくてよい。
gh issue create が失敗した場合は body-file を残す（原案を失わないため）。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

function getArg(name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

const title = getArg('--title');
const bodyFile = getArg('--body-file');
const repo = getArg('--repo');

if (!title || !bodyFile) {
  console.error(USAGE);
  process.exit(1);
}

const absBodyFile = path.resolve(toWinPath(bodyFile));
if (!fs.existsSync(absBodyFile)) {
  console.error(`body-file が見つかりません: ${absBodyFile}`);
  process.exit(1);
}

const args = ['issue', 'create', '--title', title, '--body-file', absBodyFile];
if (repo) args.push('--repo', repo);

const result = spawnSync('gh', args, { encoding: 'utf8' });

if (result.status !== 0) {
  process.stderr.write(result.stderr || '');
  console.error(`gh issue create に失敗した。body-file は保持する: ${absBodyFile}`);
  process.exit(result.status || 1);
}

const url = result.stdout.trim();
const match = url.match(/\/issues\/(\d+)/);
const number = match ? match[1] : '?';

fs.unlinkSync(absBodyFile);

console.log(`ISSUE_CREATED:${number} ${url}`);
