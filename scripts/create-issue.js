#!/usr/bin/env node
// create-issue.js
// gh issue create の唯一の呼び出し口。作成成功後に --body-file の削除を試みる。
// tmp/issue-draft.md を使い回すと、次回起票時に「既存ファイルだから読み直す」という
// 無駄なReadが発生する。削除をスクリプト側の必須処理にすることで、
// orchestrator（LLM）の記憶に依存せず毎回クリーンな状態を保証する。
//
// issue作成成功時、通常はbest-effortで対話型ワーカー「assistant」を自動起動する
// （spawn-assistant.js）。タイトルだけのアンカーIssue（--title-only）ではassistantを起動しない。
// assistant起動の成否はissue作成自体の成否と独立している — 失敗してもこのスクリプトは
// 成功として終了する（assistantはあくまで補助的な存在で、issue作成のcritical pathではない）。
'use strict';

const { spawnSync } = require('./shared/child-process');
const fs = require('fs');
const path = require('path');
const { toWinPath } = require('./shared/win-path');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { deleteInputFileBestEffort } = require('./shared/file-cleanup');
const { isRetryableGhFailure, graphqlCreateIssue } = require('./shared/gh-fallback');
const { recordCycleEvent } = require('./shared/cycle-metrics');

const USAGE = `create-issue.js — GitHub Issue を作成し、成功時にbody-fileの削除を試みる

Usage:
  node create-issue.js --title <タイトル> --body-file <path> [--repo <owner/repo>] [--workspace <path>]
  node create-issue.js --title <タイトル> --title-only [--repo <owner/repo>] [--workspace <path>]

Arguments:
  --title <タイトル>     Issue タイトル
  --body-file <path>    Issue本文ファイル（/tmp 形式可）。--title-only と排他。作成成功後に削除を試み、失敗時は警告する
  --title-only          本文なしのタイトルだけのIssueを作成する。--body-file と排他。assistantを起動しない
                        --body-file または --title-only のいずれか一方が必要（両方指定も不可）
  --repo <owner/repo>   対象リポジトリ（省略時はカレントディレクトリのリポジトリ）
  --workspace <path>    ワークスペースのルートパス（省略時は環境変数またはCWDから上方探索で解決）。
                        通常のIssue作成では、このワークスペースを起点に対話型ワーカー「assistant」を自動起動する

Output (stdout):
  ISSUE_CREATED:<番号>  作成成功。<URL> も併記される

body-file は成功時にこのスクリプトが削除を試みる。削除に失敗した場合はIssue作成成功として扱い、
原案が残った旨を警告する。gh issue create が失敗した場合もbody-fileを残す（原案を失わないため）。
--title-only は本文ファイルを作成・読み込み・削除せず、assistantも自動起動しない。

副作用: 作成成功時、spawn-assistant.js を呼び出し対話型ワーカー「assistant」をbest-effortで
自動起動する（新規WezTermウィンドウ）。assistant起動が失敗してもissue作成自体は成功として扱う
（stderrに警告が出る）。`;

function buildGhCreateArgs({ title, bodyFile, titleOnly, repo }) {
  const args = ['issue', 'create', '--title', title];
  if (titleOnly) {
    args.push('--body', '');
  } else {
    args.push('--body-file', bodyFile);
  }
  if (repo) args.push('--repo', repo);
  return args;
}

function defaultGhCreate({ title, bodyFile, titleOnly, repo }) {
  const args = buildGhCreateArgs({ title, bodyFile, titleOnly, repo });
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
 * @param {{title: string, bodyFile?: string|null, titleOnly?: boolean, repo?: string|null, workspace: string}} params
 *   bodyFile は解決済みの実体パス（呼び出し元が toWinPath 済みであること）
 * @param {object} [deps]
 * @returns {{ok: boolean, number?: string, url?: string, status?: number, stderr?: string, assistantWarning?: string|null, cleanupWarning?: string|null}}
 */
function createIssue({ title, bodyFile, titleOnly = false, repo, workspace }, deps = {}) {
  const {
    ghCreateFn = defaultGhCreate,
    isRetryableGhFailureFn = isRetryableGhFailure,
    resolveRepoForFallbackFn = defaultResolveRepoForFallback,
    graphqlCreateIssueFn = graphqlCreateIssue,
    readBodyFileFn = (p) => fs.readFileSync(p, 'utf8'),
    unlinkBodyFileFn = (p) => fs.unlinkSync(p),
    spawnAssistantFn = defaultSpawnAssistant,
    recordCycleEventFn = recordCycleEvent,
  } = deps;

  let result = ghCreateFn({ title, bodyFile, titleOnly, repo });

  if (result.status !== 0 && isRetryableGhFailureFn(result)) {
    const resolvedRepo = repo || resolveRepoForFallbackFn();
    if (resolvedRepo) {
      const body = titleOnly ? '' : readBodyFileFn(bodyFile);
      result = graphqlCreateIssueFn({ repo: resolvedRepo, title, body });
    }
  }

  if (result.status !== 0) {
    return { ok: false, status: result.status, stderr: result.stderr || '' };
  }

  const url = result.stdout.trim();
  const match = url.match(/\/issues\/(\d+)/);
  const number = match ? match[1] : '?';

  // Issue作成の成功境界。記録は補助情報なので、失敗してもIssue作成結果を変えない。
  if (number !== '?' && workspace) {
    try {
      recordCycleEventFn(workspace, number, 'issue-created', { url });
    } catch { /* best-effort */ }
  }

  const cleanupWarning = bodyFile
    ? deleteInputFileBestEffort(bodyFile, unlinkBodyFileFn)
    : null;

  const repoMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/issues\/\d+/);
  const resolvedRepoForAssistant = repo || (repoMatch ? repoMatch[1] : null);

  let assistantWarning = null;
  if (!titleOnly) {
    if (resolvedRepoForAssistant && workspace) {
      const spawnResult = spawnAssistantFn({ issue: number, repo: resolvedRepoForAssistant, workspace });
      if (spawnResult.status !== 0) {
        assistantWarning = ((spawnResult.stderr || '').toString().trim()) || 'unknown error';
      }
    } else {
      assistantWarning = 'repo/workspace を解決できずassistantを起動できませんでした';
    }
  }

  return { ok: true, number, url, assistantWarning, cleanupWarning };
}

function validateBodyMode({ bodyFile, titleOnly }) {
  if (bodyFile && titleOnly) {
    return '--body-file と --title-only は同時に指定できません';
  }
  if (!bodyFile && !titleOnly) {
    return '--body-file または --title-only のいずれかが必要です';
  }
  return null;
}

module.exports = { buildGhCreateArgs, createIssue, validateBodyMode, USAGE };

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--title': {}, '--body-file': {}, '--repo': {}, '--workspace': {} },
      booleans: ['--title-only', '--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    // ヘルプ要求かどうかは parseFlags が throw 時に確定済み。値欠落エラーが混ざっている
    // 間は helpRequested=false になり、--help を値として渡された場合にヘルプへ握りつぶさない
    // （判定の意味論は scripts/shared/workspace.js の hasGenuineHelpRequest 参照）。
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`create-issue: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    process.exit(0);
  }

  const title = values['--title'];
  const bodyFile = values['--body-file'];
  const titleOnly = values['--title-only'] === true;
  const repo = values['--repo'];

  if (!title) {
    console.error('create-issue: --title が必要です');
    console.error(USAGE);
    process.exit(1);
  }

  const bodyModeError = validateBodyMode({ bodyFile, titleOnly });
  if (bodyModeError) {
    console.error(`create-issue: ${bodyModeError}`);
    console.error(USAGE);
    process.exit(1);
  }

  // 生のprocess.cwd()を直接信用しない。--workspace省略時、orchestratorの実際のシェルCWDが
  // ワークスペースルートからズレていると（サブディレクトリでの操作後など）、assistantの
  // 登録（.gh-maestro/assistants.json）が誤った場所に書き込まれ、finalize-issue.js
  // （常に--workspace $WORKSPACEを明示）側からは見つからず、assistantが終了されない
  // 実障害になる。resolveWorkspace()の「.gh-maestro/を持つ祖先ディレクトリへの上方探索」で
  // このズレを吸収する。
  const workspace = resolveWorkspace(values['--workspace']);

  if (!workspace) {
    console.error('create-issue: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    process.exit(1);
  }

  let absBodyFile = null;
  if (bodyFile) {
    absBodyFile = path.resolve(toWinPath(bodyFile));
    try {
      fs.accessSync(absBodyFile, fs.constants.F_OK);
    } catch {
      console.error(`body-file が見つかりません: ${absBodyFile}`);
      process.exit(1);
    }
  }

  const result = createIssue({ title, bodyFile: absBodyFile, titleOnly, repo, workspace });

  if (!result.ok) {
    process.stderr.write(result.stderr || '');
    if (absBodyFile) {
      console.error(`gh issue create に失敗した。body-file は保持する: ${absBodyFile}`);
    } else {
      console.error('gh issue create に失敗した。');
    }
    process.exit(result.status || 1);
  }

  if (result.assistantWarning) {
    console.error(`create-issue: assistant起動に失敗しました（issue作成自体は成功）: ${result.assistantWarning}`);
  }

  if (result.cleanupWarning) {
    console.error(`create-issue: ${result.cleanupWarning}`);
  }

  console.log(`ISSUE_CREATED:${result.number} ${result.url}`);
}
