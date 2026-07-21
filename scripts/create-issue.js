#!/usr/bin/env node
// create-issue.js
// gh issue create の唯一の呼び出し口。作成成功後に --body-file を必ず削除する。
// tmp/issue-draft.md を使い回すと、次回起票時に「既存ファイルだから読み直す」という
// 無駄なReadが発生する。削除をスクリプト側の必須処理にすることで、
// orchestrator（LLM）の記憶に依存せず毎回クリーンな状態を保証する。
//
// issue作成成功時、best-effortで対話型ワーカー「assistant」を自動起動する（spawn-assistant.js）。
// assistant起動の成否はissue作成自体の成否と独立している — 失敗してもこのスクリプトは
// 成功として終了する（assistantはあくまで補助的な存在で、issue作成のcritical pathではない）。
'use strict';

const { spawnSync } = require('./child-process');
const fs = require('fs');
const path = require('path');
const { toWinPath } = require('./win-path');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');
const { isRetryableGhFailure, graphqlCreateIssue } = require('./shared/gh-fallback');

const USAGE = `create-issue.js — GitHub Issue を作成し、body-file を必ず削除する

Usage: node create-issue.js --title <タイトル> --body-file <path> [--repo <owner/repo>] [--workspace <path>]

Arguments:
  --title <タイトル>     Issue タイトル
  --body-file <path>    Issue本文ファイル（/tmp 形式可）。作成成功後に削除される
  --repo <owner/repo>   対象リポジトリ（省略時はカレントディレクトリのリポジトリ）
  --workspace <path>    ワークスペースのルートパス（省略時は CWD）。issue作成成功時、
                        このワークスペースを起点に対話型ワーカー「assistant」を自動起動する

Output (stdout):
  ISSUE_CREATED:<番号>  作成成功。<URL> も併記される

body-file は常にこのスクリプトが削除する。呼び出し側は削除を意識しなくてよい。
gh issue create が失敗した場合は body-file を残す（原案を失わないため）。

副作用: 作成成功時、spawn-assistant.js を呼び出し対話型ワーカー「assistant」をbest-effortで
自動起動する（新規WezTermウィンドウ）。assistant起動が失敗してもissue作成自体は成功として扱う
（stderrに警告が出る）。`;

function defaultGhCreate({ title, bodyFile, repo }) {
  const args = ['issue', 'create', '--title', title, '--body-file', bodyFile];
  if (repo) args.push('--repo', repo);
  return spawnSync('gh', args, { encoding: 'utf8' });
}

function defaultResolveRepoForFallback() {
  const repoView = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' });
  return repoView.status === 0 ? repoView.stdout.trim() : null;
}

function defaultSpawnAssistant({ issue, repo, workspace }) {
  return spawnSync(process.execPath, [
    path.join(__dirname, 'spawn-assistant.js'),
    '--issue', String(issue),
    '--repo', repo,
    '--workspace', workspace,
  ], { encoding: 'utf8' });
}

/**
 * gh issue create を実行し（必要ならGraphQLへフォールバック）、成功時は assistant を起動する。
 * CLIエントリポイントから分離してあり、deps 注入でテスト可能。
 *
 * @param {{title: string, bodyFile: string, repo?: string|null, workspace: string}} params
 *   bodyFile は解決済みの実体パス（呼び出し元が toWinPath 済みであること）
 * @param {object} [deps]
 * @returns {{ok: boolean, number?: string, url?: string, status?: number, stderr?: string, assistantWarning?: string|null}}
 */
function createIssue({ title, bodyFile, repo, workspace }, deps = {}) {
  const {
    ghCreateFn = defaultGhCreate,
    isRetryableGhFailureFn = isRetryableGhFailure,
    resolveRepoForFallbackFn = defaultResolveRepoForFallback,
    graphqlCreateIssueFn = graphqlCreateIssue,
    readBodyFileFn = (p) => fs.readFileSync(p, 'utf8'),
    unlinkBodyFileFn = (p) => fs.unlinkSync(p),
    spawnAssistantFn = defaultSpawnAssistant,
  } = deps;

  let result = ghCreateFn({ title, bodyFile, repo });

  if (result.status !== 0 && isRetryableGhFailureFn(result)) {
    const resolvedRepo = repo || resolveRepoForFallbackFn();
    if (resolvedRepo) {
      const body = readBodyFileFn(bodyFile);
      result = graphqlCreateIssueFn({ repo: resolvedRepo, title, body });
    }
  }

  if (result.status !== 0) {
    return { ok: false, status: result.status, stderr: result.stderr || '' };
  }

  const url = result.stdout.trim();
  const match = url.match(/\/issues\/(\d+)/);
  const number = match ? match[1] : '?';

  unlinkBodyFileFn(bodyFile);

  const repoMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/);
  const resolvedRepoForAssistant = repo || (repoMatch ? repoMatch[1] : null);

  let assistantWarning = null;
  if (resolvedRepoForAssistant && workspace) {
    const spawnResult = spawnAssistantFn({ issue: number, repo: resolvedRepoForAssistant, workspace });
    if (spawnResult.status !== 0) {
      assistantWarning = ((spawnResult.stderr || '').toString().trim()) || 'unknown error';
    }
  } else {
    assistantWarning = 'repo/workspace を解決できずassistantを起動できませんでした';
  }

  return { ok: true, number, url, assistantWarning };
}

module.exports = { createIssue };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--title', '--body-file', '--repo', '--workspace']);

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
  const workspace = values['--workspace'] || process.cwd();

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

  const result = createIssue({ title, bodyFile: absBodyFile, repo, workspace });

  if (!result.ok) {
    process.stderr.write(result.stderr || '');
    console.error(`gh issue create に失敗した。body-file は保持する: ${absBodyFile}`);
    process.exit(result.status || 1);
  }

  if (result.assistantWarning) {
    console.error(`create-issue: assistant起動に失敗しました（issue作成自体は成功）: ${result.assistantWarning}`);
  }

  console.log(`ISSUE_CREATED:${result.number} ${result.url}`);
}
