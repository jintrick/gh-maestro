#!/usr/bin/env node
// msg-send.js — GitHub Issue コメントを経由してメッセージを送信する
//
// Usage:
//   node msg-send.js <recipient> [--from <name>] [--issue <N>] [--workspace <path>] "<本文>"
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search
//
// from resolution order:
//   --from arg > GH_MAESTRO_WORKER env > 'orchestrator'

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');

const USAGE = `msg-send.js — GitHub Issue コメント経由でメッセージを送信する

Usage: node msg-send.js <recipient> [--from <name>] [--issue <N>] [--workspace <path>] "<本文>"

Arguments:
  <recipient>           送信先（worker 名、または "orchestrator"）
  <本文>                メッセージ本文

Options:
  --from <name>         送信元名（省略時は GH_MAESTRO_WORKER env → 'orchestrator'）
  --issue <N>           投稿先の Issue 番号（省略時は workers.json または env ISSUE から解決）
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）

Output (stdout):
  投稿されたコメントの URL を1行出力

workspace 解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索
from 解決順: --from 引数 > GH_MAESTRO_WORKER env > 'orchestrator'`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', ...opts });
};

let _ghIssueComment = (issue, body, opts = {}) => {
  return spawnSync('gh', ['issue', 'comment', String(issue), '--body-file', '-'], {
    input: body, encoding: 'utf8', ...opts,
  });
};

// ── メインロジック ──────────────────────────────────────────────────────

/**
 * @param {string[]} [argsOverride]  省略時は process.argv.slice(2)
 * @param {object}   [envOverride]   省略時は process.env
 * @returns {{ code: number, lines: string[], errLines: string[] }}
 */
function main(argsOverride, envOverride) {
  const out = [];
  const err = [];

  const writeOut = (s) => out.push(s);
  const writeErr = (s) => err.push(s);

  const args = argsOverride || process.argv.slice(2);
  const env = envOverride || process.env;

  if (args.includes('--help') || args.includes('-h')) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--issue', '--from']);

  if (exitFlagMiss) {
    writeErr('msg-send: フラグには値が必要です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const recipient = rest[0];
  const body = rest.slice(1).join(' ');

  if (!recipient) {
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (!body) {
    writeErr('msg-send: メッセージ本文が必要です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('msg-send: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err };
  }

  // ── from の解決 ────────────────────────────────────────────────────────

  const from = values['--from'] || env.GH_MAESTRO_WORKER || 'orchestrator';

  // ── issue の解決 ────────────────────────────────────────────────────────
  // 優先順: --issue > env ISSUE > workers.json（worker 宛のみ）
  // orchestrator 宛で --issue も env ISSUE も無ければ exit 1（フェイルクローズ）

  let issue = values['--issue'] || env.ISSUE || null;

  if (!issue && recipient !== 'orchestrator') {
    // worker 宛: workers.json から解決を試みる
    const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
    try {
      if (fs.existsSync(workersPath)) {
        const workers = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
        const entry = workers[recipient];
        if (entry && entry.issue) {
          issue = String(entry.issue);
        }
      }
    } catch {
      // workers.json が読めない/parse できない → issue 未解決のまま
    }
  }

  if (!issue) {
    writeErr('msg-send: Issue番号を解決できません。--issue で指定するか、ISSUE 環境変数を設定してください。');
    return { code: 1, lines: out, errLines: err };
  }

  // ── リポジトリ解決 ──────────────────────────────────────────────────────

  const ghOpts = { cwd: workspace };
  const repoResult = _ghRepoView(ghOpts);
  if (repoResult.status !== 0) {
    writeErr(`msg-send: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err };
  }
  const repo = repoResult.stdout.trim();
  if (!repo) {
    writeErr('msg-send: リポジトリを解決できません（空のレスポンス）。');
    return { code: 1, lines: out, errLines: err };
  }

  // ── マーカー生成 ────────────────────────────────────────────────────────

  const marker = JSON.stringify({ v: 1, to: recipient, from });
  const fullBody = `<!-- gh-maestro ${marker} -->\n${body}`;

  // ── 送信 ────────────────────────────────────────────────────────────────

  const result = _ghIssueComment(issue, fullBody, ghOpts);

  if (result.status !== 0) {
    writeErr(`msg-send: コメント投稿に失敗しました: ${result.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err };
  }

  const commentUrl = result.stdout.trim();
  if (!commentUrl) {
    writeErr('msg-send: コメント投稿は成功しましたがURLが取得できませんでした。');
    return { code: 1, lines: out, errLines: err };
  }

  writeOut(commentUrl);
  return { code: 0, lines: out, errLines: err };
}

// ── テスト用 export ──────────────────────────────────────────────────────

module.exports = {
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhIssueComment: (fn) => { _ghIssueComment = fn; },
  main,
  USAGE,
};

if (require.main === module) {
  const { code, lines, errLines } = main();
  for (const l of errLines) process.stderr.write(l + '\n');
  for (const l of lines) process.stdout.write(l + '\n');
  process.exit(code);
}
