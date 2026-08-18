#!/usr/bin/env node
// msg-read.js — GitHub Issue コメントまたは計画の本文を読み出す
//
// Usage:
//   node msg-read.js <commentId> [--workspace <path>] [--issue <N>]
//   node msg-read.js --plan --issue <N> [--workspace <path>]
//
// エージェントが repo 解決や jq クエリを手書きせず、1コマンドで本文を読めるようにする。

'use strict';

const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { isRetryableGhFailure, graphqlCommentBody } = require('./shared/gh-fallback');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const { findPlanComments, stripPlanMarker } = require('./shared/plan-comment');

const USAGE = `msg-read.js — GitHub Issue コメントまたは計画の本文を読み出す

Usage:
  node msg-read.js <commentId> [--workspace <path>] [--issue <N>]
  node msg-read.js --plan --issue <N> [--workspace <path>]

Arguments:
  <commentId>           読み出すコメントの ID（数値）。--plan 指定時は指定不可

Options:
  --plan                Issue の pin 済み計画コメント本文を読み出す（--issue 必須）
  --issue <N>           対象 Issue 番号。--plan 指定時は必須（正の整数）。
                        通常指定時は REST 失敗時の GraphQL フォールバック用（任意）。
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

Output (stdout):
  マーカー行を除いたコメント本文または計画本文

workspace 解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = () => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8' });
};

let _ghApiComment = (repo, commentId, issue) => {
  const restResult = spawnSync('gh', ['api', `repos/${repo}/issues/comments/${commentId}`, '-q', '.body'],
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

const MARKER_RE = /^<!--\s*gh-maestro\s+(\{.*\})\s*-->/;

// ── 本文からマーカー行を除去する（テスト用 export） ─────────────────────────

function stripMarker(body) {
  const lines = body.split('\n');
  if (lines.length > 0 && MARKER_RE.test(lines[0])) {
    lines.shift();
  }
  return lines.join('\n');
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
      booleans: ['--plan', '--help', '-h'],
      // commentId は通常時にちょうど1つの位置引数。--plan 指定時は0個。
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

  if (isPlan) {
    if (rest.length > 0) {
      writeErr('msg-read: --plan 指定時は commentId を指定できません。');
      writeErr(USAGE);
      return { code: 1, lines: out, errLines: err };
    }
    if (!values['--issue']) {
      writeErr('msg-read: --plan 指定時は --issue <N> が必須です。');
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

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('msg-read: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err };
  }

  // ── リポジトリ解決 ──────────────────────────────────────────────────

  const repoResult = _ghRepoView();
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
    const ghOpts = { cwd: workspace };
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
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhApiComment: (fn) => { _ghApiComment = fn; },
  _setGhListComments: (fn) => { _ghListComments = fn; },
  main,
  stripMarker,
  USAGE,
};

if (require.main === module) {
  const { code, lines, errLines } = main();
  for (const l of errLines) process.stderr.write(l + '\n');
  for (const l of lines) process.stdout.write(l + '\n');
  process.exit(code);
}
