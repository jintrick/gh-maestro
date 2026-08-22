#!/usr/bin/env node
// msg-read.js — GitHub Issue コメント・計画・Issueコンテキストを読み出す
//
// Usage:
//   node msg-read.js <commentId> [--workspace <path>] [--issue <N>]
//   node msg-read.js --plan --issue <N> [--workspace <path>]
//   node msg-read.js --issue-context --issue <N> [--workspace <path>]
//
// エージェントが repo 解決や jq クエリを手書きせず、1コマンドで本文を読めるようにする。

'use strict';

const { spawnSync } = require('./shared/child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { isRetryableGhFailure, graphqlCommentBody } = require('./shared/gh-fallback');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const { findPlanComments, isPlanComment, stripPlanMarker } = require('./shared/plan-comment');
const { parseMarker } = require('./msg-poll');
const { isWorkerIdentity } = require('./shared/resident-force-guard');

const USAGE = `msg-read.js — GitHub Issue コメント、計画、Issueコンテキストを読み出す

Usage:
  node msg-read.js <commentId> [--workspace <path>] [--issue <N>]
  node msg-read.js --plan --issue <N> [--workspace <path>]
  node msg-read.js --issue-context --issue <N> [--workspace <path>]

Arguments:
  <commentId>           読み出すコメントの ID（数値）。--plan/--issue-context 指定時は指定不可

Options:
  --plan                Issue の pin 済み計画コメント本文を読み出す（--issue 必須）
  --issue-context       Issue のタイトル・本文と、宛先フィルタ済みコメント一覧を読み出す
                        （--issue と GH_MAESTRO_WORKER が必須）
  --issue <N>           対象 Issue 番号。--plan 指定時は必須（正の整数）。
                        --issue-context 指定時も必須。通常指定時は REST 失敗時の
                        GraphQL フォールバック用（任意）。
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

Output (stdout):
  通常モード: マーカー行を除いたコメント本文
  --plan: マーカー行を除いた計画本文
  --issue-context: Issueタイトル・本文と、gh-maestroマーカーで自分宛てと判定された
                   コメントおよびpin済み計画コメント（各マーカー除去済み）

workspace 解決順: --workspace 引数 > GH_MAESTRO_WORKSPACE env > CWD から上方探索`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

const defaultSpawnSync = spawnSync;
let _spawnSync = defaultSpawnSync;

const defaultGhRepoView = (opts = {}) => {
  return _spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', ...opts });
};

let _ghRepoView = defaultGhRepoView;

let _ghApiComment = (repo, commentId, issue) => {
  const restResult = _spawnSync('gh', ['api', `repos/${repo}/issues/comments/${commentId}`, '-q', '.body'],
    { encoding: 'utf8' });

  if (restResult.status === 0 || !isRetryableGhFailure(restResult)) {
    return restResult;
  }

  process.stderr.write('msg-read: REST API失敗のためGraphQLにフォールバックします\n');
  return graphqlCommentBody({ repo, commentId, issue });
};

let _ghListComments = (repo, issue, opts = {}) => {
  return listComments(repo, issue, opts);
};

const defaultGhApiIssue = (repo, issue, opts = {}) => {
  return _spawnSync('gh', ['api', '--method', 'GET', `repos/${repo}/issues/${issue}`],
    { encoding: 'utf8', ...opts });
};

let _ghApiIssue = defaultGhApiIssue;

const MARKER_RE = /^<!--\s*gh-maestro\s+(\{.*\})\s*-->/;

// ── 本文からマーカー行を除去する（テスト用 export） ─────────────────────────

function stripMarker(body) {
  const lines = body.split('\n');
  if (lines.length > 0 && MARKER_RE.test(lines[0])) {
    lines.shift();
  }
  return lines.join('\n');
}

/**
 * Issue本文とコメント一覧を、ワーカー自身が読むべき内容だけに絞り込む。
 *
 * 機械マーカーのないコメントは投稿元・宛先を確認できないため出力しない。
 * pin済み計画コメントだけは宛先を持たない正規のgh-maestroコメントとして扱う。
 *
 * @param {object[]} comments
 * @param {string} workerName GH_MAESTRO_WORKER
 * @returns {string[]} マーカーを除去したコメント本文
 */
function filterIssueCommentBodies(comments, workerName) {
  if (!workerName) {
    throw new Error('GH_MAESTRO_WORKER が設定されていません');
  }
  if (!Array.isArray(comments)) return [];

  const bodies = [];
  for (const comment of comments) {
    if (!comment || typeof comment.body !== 'string') continue;

    if (isPlanComment(comment)) {
      const planBody = stripPlanMarker(comment.body);
      if (planBody.trim()) bodies.push(planBody);
      continue;
    }

    const meta = parseMarker(comment.body);
    if (!meta || meta.to !== workerName) continue;

    const messageBody = stripMarker(comment.body);
    if (messageBody.trim()) bodies.push(messageBody);
  }
  return bodies;
}

/**
 * `gh api repos/{repo}/issues/{issue}` の応答からIssue本文を取り出す。
 * title は必須、body の null は空本文として扱う。
 *
 * @param {string} stdout
 * @returns {{ title: string, body: string }|null}
 */
function parseIssueResponse(stdout) {
  let issue;
  try {
    issue = JSON.parse(stdout || '');
  } catch {
    return null;
  }
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return null;
  if (typeof issue.title !== 'string') return null;
  if (issue.body !== null && typeof issue.body !== 'string') return null;
  return { title: issue.title, body: issue.body || '' };
}

/**
 * Issue本文とフィルタ済みコメント本文を、エージェントが読むテキストへ整形する。
 *
 * @param {{ title: string, body: string }} issue
 * @param {string[]} commentBodies
 * @returns {string}
 */
function formatIssueContext(issue, commentBodies) {
  const sections = [];
  if (issue.title) sections.push(issue.title);
  if (issue.body) sections.push(issue.body);
  if (commentBodies.length > 0) {
    sections.push(`Comments:\n\n${commentBodies.join('\n\n---\n\n')}`);
  }
  return sections.join('\n\n');
}

// ── メインロジック ──────────────────────────────────────────────────────

/**
 * @param {string[]} [argsOverride]  省略時は process.argv.slice(2)
 * @returns {{ code: number, lines: string[], errLines: string[] }}
 */
function main(argsOverride) {
  const out = [];
  const err = [];

  const writeOut = (s) => out.push(s);
  const writeErr = (s) => err.push(s);

  const args = argsOverride || process.argv.slice(2);

  let values, rest;
  try {
    ({ values, rest } = parseFlags(args, {
      flags: { '--workspace': {}, '--issue': {} },
      booleans: ['--plan', '--issue-context', '--help', '-h'],
      // commentId は通常時にちょうど1つの位置引数。--plan/--issue-context 指定時は0個。
      positionals: { min: 0, max: 1 },
    }));
  } catch (e) {
    if (e.name !== 'ArgsValidationError') throw e;
    if (e.helpRequested) {
      writeOut(USAGE);
      return { code: 0, lines: out, errLines: err };
    }
    for (const ve of e.errors) writeErr(`msg-read: ${ve.message}`);
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (values['--help'] || values['-h']) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const isPlan = values['--plan'] === true;
  const isIssueContext = values['--issue-context'] === true;

  if (isPlan && isIssueContext) {
    writeErr('msg-read: --plan と --issue-context は同時指定できません。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (isPlan || isIssueContext) {
    if (rest.length > 0) {
      writeErr(`msg-read: ${isPlan ? '--plan' : '--issue-context'} 指定時は commentId を指定できません。`);
      writeErr(USAGE);
      return { code: 1, lines: out, errLines: err };
    }
    if (!values['--issue']) {
      writeErr(`msg-read: ${isPlan ? '--plan' : '--issue-context'} 指定時は --issue <N> が必須です。`);
      writeErr(USAGE);
      return { code: 1, lines: out, errLines: err };
    }
    if (!/^[1-9]\d*$/.test(values['--issue'])) {
      writeErr('msg-read: --issue は正の整数で指定してください。');
      return { code: 1, lines: out, errLines: err };
    }
  } else {
    if (rest.length !== 1) {
      writeErr(USAGE);
      return { code: 1, lines: out, errLines: err };
    }
  }

  const workerName = isIssueContext ? (process.env.GH_MAESTRO_WORKER || null) : null;
  if (isIssueContext && !isWorkerIdentity(workerName)) {
    writeErr('msg-read: --issue-context は GH_MAESTRO_WORKER が設定されたワーカーから実行してください。');
    return { code: 1, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('msg-read: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err };
  }

  // ── リポジトリ解決 ──────────────────────────────────────────────────

  const ghOpts = { cwd: workspace };
  const repoResult = _ghRepoView(ghOpts);
  if (repoResult.status !== 0) {
    writeErr(`msg-read: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err };
  }
  const repo = repoResult.stdout.trim();
  if (!repo) {
    writeErr('msg-read: リポジトリを解決できません（空のレスポンス）');
    return { code: 1, lines: out, errLines: err };
  }

  // ── 読み出し処理 ─────────────────────────────────────────────────────

  if (isPlan) {
    const issue = values['--issue'];
    const listResult = _ghListComments(repo, issue, ghOpts);
    if (listResult.status !== 0) {
      writeErr(`msg-read: コメント一覧の取得に失敗しました: ${listResult.stderr || '(empty)'}`);
      return { code: 1, lines: out, errLines: err };
    }

    let comments;
    try {
      comments = parseCommentsResponse(listResult.stdout);
    } catch {
      writeErr('msg-read: コメント一覧のJSONパースに失敗しました');
      return { code: 1, lines: out, errLines: err };
    }

    if (!Array.isArray(comments)) {
      writeErr('msg-read: コメント一覧の形式が不正です');
      return { code: 1, lines: out, errLines: err };
    }

    const plans = findPlanComments(comments);
    if (plans.length === 0) {
      writeErr(`msg-read: Issue #${issue} に計画コメントが見つかりません。`);
      return { code: 1, lines: out, errLines: err };
    }
    if (plans.length > 1) {
      writeErr(`msg-read: Issue #${issue} に計画コメントが複数存在します（${plans.length}件）。`);
      return { code: 1, lines: out, errLines: err };
    }

    const planBody = plans[0].body || '';
    const stripped = stripPlanMarker(planBody);
    writeOut(stripped);
    return { code: 0, lines: out, errLines: err };
  }

  if (isIssueContext) {
    const issue = values['--issue'];
    const issueResult = _ghApiIssue(repo, issue, ghOpts);
    if (issueResult.status !== 0) {
      writeErr(`msg-read: Issue本文の取得に失敗しました: ${issueResult.stderr || '(empty)'}`);
      return { code: 1, lines: out, errLines: err };
    }

    const issueData = parseIssueResponse(issueResult.stdout);
    if (!issueData) {
      writeErr('msg-read: Issue本文のJSONパースまたは形式検証に失敗しました');
      return { code: 1, lines: out, errLines: err };
    }

    const listResult = _ghListComments(repo, issue, ghOpts);
    if (listResult.status !== 0) {
      writeErr(`msg-read: コメント一覧の取得に失敗しました: ${listResult.stderr || '(empty)'}`);
      return { code: 1, lines: out, errLines: err };
    }

    let comments;
    try {
      comments = parseCommentsResponse(listResult.stdout);
    } catch {
      writeErr('msg-read: コメント一覧のJSONパースに失敗しました');
      return { code: 1, lines: out, errLines: err };
    }

    if (!Array.isArray(comments)) {
      writeErr('msg-read: コメント一覧の形式が不正です');
      return { code: 1, lines: out, errLines: err };
    }

    const commentBodies = filterIssueCommentBodies(comments, workerName);
    writeOut(formatIssueContext(issueData, commentBodies));
    return { code: 0, lines: out, errLines: err };
  }

  const commentId = rest[0];
  const result = _ghApiComment(repo, commentId, values['--issue']);

  if (result.status !== 0) {
    writeErr(`msg-read: コメントの読み出しに失敗しました: ${result.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err };
  }

  const body = result.stdout;
  const stripped = stripMarker(body);
  writeOut(stripped);
  return { code: 0, lines: out, errLines: err };
}

// ── テスト用 export ──────────────────────────────────────────────────────

module.exports = {
  _setSpawnSync: (fn) => { _spawnSync = fn || defaultSpawnSync; },
  _setGhRepoView: (fn) => { _ghRepoView = fn || defaultGhRepoView; },
  _setGhApiComment: (fn) => { _ghApiComment = fn; },
  _setGhApiIssue: (fn) => { _ghApiIssue = fn || defaultGhApiIssue; },
  _setGhListComments: (fn) => { _ghListComments = fn; },
  filterIssueCommentBodies,
  formatIssueContext,
  main,
  parseIssueResponse,
  stripMarker,
  USAGE,
};

if (require.main === module) {
  const { code, lines, errLines } = main();
  for (const l of errLines) process.stderr.write(l + '\n');
  for (const l of lines) process.stdout.write(l + '\n');
  process.exit(code);
}
