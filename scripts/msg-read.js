#!/usr/bin/env node
// msg-read.js — GitHub Issue コメントの本文を読み出す
//
// Usage:
//   node msg-read.js <commentId> [--workspace <path>]
//
// エージェントが repo 解決や jq クエリを手書きせず、1コマンドで本文を読めるようにする。

'use strict';

const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { isRetryableGhFailure, graphqlCommentBody } = require('./shared/gh-fallback');

const USAGE = `msg-read.js — GitHub Issue コメントの本文を読み出す

Usage: node msg-read.js <commentId> [--workspace <path>] [--issue <N>]

Arguments:
  <commentId>           読み出すコメントの ID（数値）

Options:
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）
  --issue <N>           コメントが投稿されている Issue 番号。REST APIが失敗した際の
                        GraphQLフォールバック専用（GraphQLはコメントIDから直接本文を
                        引くrootクエリを持たないため）。REST成功時は使用されない。
                        省略時、フォールバックが必要になった場合はエラーで終了する。

Output (stdout):
  マーカー行を除いたコメント本文

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
  return graphqlCommentBody({ repo, issue, commentId });
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

  if (args.includes('--help') || args.includes('-h')) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--issue']);

  if (exitFlagMiss) {
    writeErr('msg-read: フラグには値が必要です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  // 正当な位置引数は commentId の1つのみ。余剰な位置引数・未知フラグは黙って無視しない
  // （spawn-worker.js / create-issue.js と同じ rest 検証パターン。argv-parsing-pitfalls参照）。
  if (rest.length > 1) {
    writeErr(`msg-read: 未知の引数です: ${rest.slice(1).join(' ')}`);
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const commentId = rest[0];

  if (!commentId) {
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
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

  // ── コメント読み出し ─────────────────────────────────────────────────

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
