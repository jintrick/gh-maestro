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
const { parseFlags, hasHelpFlag } = require('./shared/workspace');
const { isRetryableGhFailure, graphqlCreateIssue } = require('./shared/gh-fallback');

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

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--title', '--body-file', '--repo']);

  // exitFlagMiss（値欠落）を先に判定する。フラグの値が欠落した場合、その
  // 未消費トークンが rest に残るため、それがたまたま "--help" と一致すると
  // 後段の hasHelpFlag チェックが誤って help 扱いしてしまう。値欠落は常に
  // エラー優先（フェイルクローズ）とし、help 判定より先に確定させる。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  const title = values['--title'];
  const bodyFile = values['--body-file'];
  const repo = values['--repo'];

  if (!title || !bodyFile || rest.length > 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const absBodyFile = path.resolve(toWinPath(bodyFile));
  try {
    fs.accessSync(absBodyFile, fs.constants.F_OK);
  } catch {
    console.error(`body-file が見つかりません: ${absBodyFile}`);
    process.exit(1);
  }

  const args = ['issue', 'create', '--title', title, '--body-file', absBodyFile];
  if (repo) args.push('--repo', repo);

  let result = spawnSync('gh', args, { encoding: 'utf8' });

  if (result.status !== 0 && isRetryableGhFailure(result)) {
    process.stderr.write('create-issue: REST API失敗のためGraphQLにフォールバックします\n');
    const resolvedRepo = repo || (() => {
      const repoView = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' });
      return repoView.status === 0 ? repoView.stdout.trim() : null;
    })();
    if (resolvedRepo) {
      const body = fs.readFileSync(absBodyFile, 'utf8');
      result = graphqlCreateIssue({ repo: resolvedRepo, title, body });
    }
  }

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
}
