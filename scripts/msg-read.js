#!/usr/bin/env node
// msg-read.js — GitHub Issue コメントの本文を読み出す
//
// Usage:
//   node msg-read.js <commentId> [--workspace <path>]
//
// エージェントが repo 解決や jq クエリを手書きせず、1コマンドで本文を読めるようにする。

'use strict';

const { spawnSync } = require('child_process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');

const USAGE = `msg-read.js — GitHub Issue コメントの本文を読み出す

Usage: node msg-read.js <commentId> [--workspace <path>]

Arguments:
  <commentId>           読み出すコメントの ID（数値）

Options:
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

Output (stdout):
  マーカー行を除いたコメント本文

workspace 解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = () => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8' });
};

let _ghApiComment = (repo, commentId) => {
  return spawnSync('gh', ['api', `repos/${repo}/issues/comments/${commentId}`, '-q', '.body'],
    { encoding: 'utf8' });
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

  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace']);

  if (exitFlagMiss) {
    writeErr('msg-read: フラグには値が必要です。');
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

  const result = _ghApiComment(repo, commentId);

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
