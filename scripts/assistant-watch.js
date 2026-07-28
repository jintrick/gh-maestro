#!/usr/bin/env node
// assistant-watch.js — assistant向け、issueの進行状況を検知する読み取り専用ポーリング
//
// Usage: node assistant-watch.js --issue <N> [--workspace <path>] [--repo <owner/repo>]
//                                 [--wait <sec>] [--interval <sec>]
//
// 検知する4種のイベント（Issue #166）:
//   worker_report — ワーカー→オーケストレーターへのIssueコメント報告（msg-send.jsマーカー）
//   hanseikai     — 【反省会】で始まるIssueコメント
//   review_done   — Review Managerの .running ロックファイルの消失
//   pr_merged     — 既知PRがマージ済みへ遷移
//
// 副作用ゼロ（gh の参照系コマンドとローカルファイルの読み取りのみ）。
// scripts/poll-pr.js・scripts/msg-poll.js は呼び出さない・内部でも流用しない
// （前者はPR検出時にReview Managerを自動起動する副作用を持ち、後者はorchestrator専用の
// 単一起動規約・プロセスレジストリ登録を持つ。どちらも独立に叩くとオーケストレーター
// 本体の状態と衝突しうる）。gh呼び出しの一時的な失敗（ネットワーク断等）は、通知が
// 1サイクル遅れるだけで実害が無い「お知らせフィード」の性質上、gh-fallback.jsの
// GraphQLフォールバックは持たせない（そのサイクルをスキップし次サイクルで再試行する）。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags, hasHelpFlag } = require('./shared/workspace');
// parseCommentsResponse/parseMarker は副作用の無い純粋なパース関数（gh呼び出し・state永続化・
// プロセスレジストリ登録は一切含まない）なので、上記の「msg-poll.js を流用しない」制約とは
// 矛盾しない。DRYのため素直に再利用する。
const { parseCommentsResponse, parseMarker } = require('./msg-poll');
const { reviewArtifactPath } = require('./shared/review-manager-paths');

const DEFAULT_INTERVAL_SEC = 20;
const DEFAULT_WAIT_SEC = 1200;
const GH_TIMEOUT_MS = 30000;
const ISSUE_RE = /^[1-9]\d*$/;

const USAGE = `assistant-watch.js — assistant向け、issueの進行状況を検知する読み取り専用ポーリング

Usage: node assistant-watch.js --issue <N> [--workspace <path>] [--repo <owner/repo>]
                                [--wait <sec>] [--interval <sec>]

Arguments:
  --issue <N>          監視対象のアンカーIssue番号（必須）

Options:
  --workspace <path>   ワークスペースパス（省略時は環境変数またはCWDから解決）
  --repo <owner/repo>  対象リポジトリ（省略時はワークスペースのgit remoteから解決）
  --wait <sec>         新着イベントを検知するか、指定秒数が経過するまでフォアグラウンドで
                        待機する（既定: ${DEFAULT_WAIT_SEC}秒）。内部的には --interval 秒間隔でリトライする。
  --interval <sec>     ポーリング間隔（秒、既定: ${DEFAULT_INTERVAL_SEC}）

Output (stdout):
  新規イベントを検知した場合、1行以上の \`EVENT <json>\` を出力してexit 0。
    json.type: "worker_report" | "hanseikai" | "review_done" | "pr_merged"
  タイムアウトまで何も見つからなければ \`TIMEOUT\` を1行出力してexit 0。

副作用: 読み取り専用。gh issue view / gh pr list 等の参照コマンドとローカルファイルの
存在確認のみを行う。コメント投稿・ワーカー起動・Review Manager起動等は一切行わない。

カーソル（最後に確認したコメントID・既知PRごとの状態）は
<workspace>/.gh-maestro/assistant-watch/<issue>.json に永続化する。
state ファイルが存在しない・壊れている場合、msg-poll.js とは異なり「過去イベントの
再通知」はしない（このスクリプトは通知フィードであり、取りこぼしが致命的なinboxでは
ないため）。現在の状態を基準として静かにベースラインを確立し、以後の変化だけを報告する。`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

let _ghIssueComments = (repo, issue, opts = {}) => {
  const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp', '-f', 'per_page=100'];
  return spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

let _ghPrList = (repo, issue, opts = {}) => {
  const args = [
    'pr', 'list', '--repo', repo, '--state', 'all',
    '--search', `${issue} in:body`,
    '--json', 'number,state,mergedAt',
  ];
  return spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

// ── state永続化 ──────────────────────────────────────────────────────────

function statePath(workspace, issue) {
  return path.join(workspace, '.gh-maestro', 'assistant-watch', `${issue}.json`);
}

/**
 * @returns {{ lastCommentId: number, prs: Record<string, { merged: boolean, reviewSeenRunning: boolean, reviewReported: boolean }> } | null}
 *   壊れている・存在しない場合は null（呼び出し側がベースラインを確立する）。
 */
function readState(workspace, issue) {
  try {
    const sp = statePath(workspace, issue);
    if (!fs.existsSync(sp)) return null;
    const parsed = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const prs = {};
    if (parsed.prs && typeof parsed.prs === 'object') {
      for (const [k, v] of Object.entries(parsed.prs)) {
        if (v && typeof v === 'object') {
          prs[k] = {
            merged: !!v.merged,
            reviewSeenRunning: !!v.reviewSeenRunning,
            reviewReported: !!v.reviewReported,
          };
        }
      }
    }
    return {
      lastCommentId: typeof parsed.lastCommentId === 'number' ? parsed.lastCommentId : 0,
      prs,
    };
  } catch {
    return null;
  }
}

function writeState(workspace, issue, state) {
  const sp = statePath(workspace, issue);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  const tmp = sp + '.' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, sp);
}

// ── ヘルパー ──────────────────────────────────────────────────────────────

/**
 * msg-send.js のマーカー付き本文から、人間可読部分（引用ヘッダー以下）だけを取り出し、
 * 長すぎる場合は切り詰める。
 */
function extractPreview(body, maxLen = 300) {
  const withoutMarker = (body || '').replace(/^<!--[\s\S]*?-->\n?/, '').trim();
  return withoutMarker.length > maxLen ? withoutMarker.slice(0, maxLen) + '…' : withoutMarker;
}

function firstLine(body) {
  return (body || '').split(/\r?\n/)[0] || '';
}

// ── 1サイクル分のスキャン ────────────────────────────────────────────────

/**
 * @param {{ workspace: string, ghDir: string, repo: string, issue: string, state: object,
 *   isBaseline: boolean, ghOpts: object }} params
 * @returns {{ events: object[], errors: string[] }}
 */
function scanOnce({ workspace, ghDir, repo, issue, state, isBaseline, ghOpts }) {
  const events = [];
  const errors = [];

  // ── Issueコメント（worker_report / hanseikai） ──────────────────────────
  const commentsResult = _ghIssueComments(repo, issue, ghOpts);
  if (commentsResult.status !== 0) {
    errors.push(`gh api エラー（コメント取得）: ${commentsResult.stderr || '(empty)'}`);
  } else {
    let comments = [];
    try {
      comments = parseCommentsResponse(commentsResult.stdout) || [];
    } catch {
      errors.push('コメント応答のJSON parseに失敗しました');
    }
    comments.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));

    let maxSeenId = state.lastCommentId;
    for (const c of comments) {
      if (c.id == null || c.id <= state.lastCommentId) continue;
      if (c.id > maxSeenId) maxSeenId = c.id;
      if (isBaseline) continue; // 初回はベースライン確立のみ。イベント化しない。

      const body = c.body || '';
      if (body.startsWith('【反省会】')) {
        events.push({ type: 'hanseikai', commentId: c.id, preview: firstLine(body) });
        continue;
      }
      const meta = parseMarker(body);
      if (meta && meta.from && meta.from !== 'orchestrator') {
        events.push({ type: 'worker_report', commentId: c.id, from: meta.from, preview: extractPreview(body) });
      }
    }
    state.lastCommentId = maxSeenId;
  }

  // ── PR一覧（review_done / pr_merged） ───────────────────────────────────
  const prResult = _ghPrList(repo, issue, ghOpts);
  if (prResult.status !== 0) {
    errors.push(`gh api エラー（PR一覧取得）: ${prResult.stderr || '(empty)'}`);
    return { events, errors };
  }
  let prs = [];
  try {
    prs = JSON.parse(prResult.stdout || '[]');
  } catch {
    errors.push('PR一覧応答のJSON parseに失敗しました');
    return { events, errors };
  }
  if (!Array.isArray(prs)) prs = [];

  for (const pr of prs) {
    if (pr.number == null) continue;
    const key = String(pr.number);
    const merged = pr.state === 'MERGED' || !!pr.mergedAt;
    const runningLockPath = reviewArtifactPath(ghDir, pr.number, '.running');
    const reviewRunning = fs.existsSync(runningLockPath);

    if (!state.prs[key]) {
      // 新規検出したPR。現在の状態をそのままベースラインにする（このPR自体の検出を
      // イベント化しない。PR作成自体は通常worker_reportで既に伝わっているため）。
      state.prs[key] = { merged, reviewSeenRunning: reviewRunning, reviewReported: false };
      continue;
    }

    const prState = state.prs[key];

    if (isBaseline) {
      // 初回スキャン全体がベースライン確立のみの場合、既知PRの状態も上書きするだけに留める。
      prState.merged = merged;
      prState.reviewSeenRunning = reviewRunning || prState.reviewSeenRunning;
      continue;
    }

    if (reviewRunning) {
      prState.reviewSeenRunning = true;
    } else if (prState.reviewSeenRunning && !prState.reviewReported) {
      events.push({ type: 'review_done', pr: pr.number });
      prState.reviewReported = true;
    }

    if (merged && !prState.merged) {
      events.push({ type: 'pr_merged', pr: pr.number, mergedAt: pr.mergedAt || null });
    }
    prState.merged = merged;
  }

  return { events, errors };
}

// ── 引数解析 ──────────────────────────────────────────────────────────────

function parseArgs(args) {
  if (hasHelpFlag(args)) return { help: true };

  const { values, rest, exitFlagMiss } = parseFlags(
    args, ['--issue', '--workspace', '--repo', '--wait', '--interval'],
  );
  if (exitFlagMiss) return { help: false, exitFlagMiss: true };
  if (rest.length > 0) return { help: false, unknownArgs: rest };

  return {
    help: false,
    exitFlagMiss: false,
    issueArg: values['--issue'],
    workspaceArg: values['--workspace'],
    repoArg: values['--repo'],
    waitArg: values['--wait'],
    intervalArg: values['--interval'],
  };
}

// ── メインロジック ──────────────────────────────────────────────────────

let _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string[]} [argsOverride]
 * @returns {Promise<{ code: number, lines: string[], errLines: string[] }>}
 */
async function main(argsOverride) {
  const out = [];
  const err = [];
  const args = argsOverride || process.argv.slice(2);

  const parsed = parseArgs(args);
  if (parsed.help) {
    out.push(USAGE);
    return { code: 0, lines: out, errLines: err };
  }
  if (parsed.exitFlagMiss) {
    err.push('assistant-watch: フラグには値が必要です。');
    err.push(USAGE);
    return { code: 1, lines: out, errLines: err };
  }
  if (parsed.unknownArgs) {
    err.push(`assistant-watch: 未知の引数です: ${parsed.unknownArgs.join(' ')}`);
    err.push(USAGE);
    return { code: 1, lines: out, errLines: err };
  }
  if (!parsed.issueArg || !ISSUE_RE.test(parsed.issueArg)) {
    err.push('assistant-watch: --issue には正の整数を指定してください。');
    err.push(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(parsed.workspaceArg);
  if (!workspace) {
    err.push('assistant-watch: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err };
  }

  const waitSec = parsed.waitArg != null ? parseInt(parsed.waitArg, 10) : DEFAULT_WAIT_SEC;
  if (!Number.isFinite(waitSec) || waitSec <= 0) {
    err.push(`assistant-watch: --wait には正の整数（秒）を指定してください: ${parsed.waitArg}`);
    return { code: 1, lines: out, errLines: err };
  }
  const intervalSec = parsed.intervalArg != null ? parseInt(parsed.intervalArg, 10) : DEFAULT_INTERVAL_SEC;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    err.push(`assistant-watch: --interval には正の整数（秒）を指定してください: ${parsed.intervalArg}`);
    return { code: 1, lines: out, errLines: err };
  }

  const ghOpts = { cwd: workspace };
  let repo = parsed.repoArg;
  if (!repo) {
    const repoResult = _ghRepoView(ghOpts);
    if (repoResult.status !== 0) {
      err.push(`assistant-watch: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}`);
      return { code: 1, lines: out, errLines: err };
    }
    repo = repoResult.stdout.trim();
  }

  const issue = parsed.issueArg;
  const ghDir = path.join(workspace, '.gh-maestro');
  const existingState = readState(workspace, issue);
  const isFirstEverRun = existingState === null;
  const state = existingState || { lastCommentId: 0, prs: {} };

  const waitMs = waitSec * 1000;
  const intervalMs = intervalSec * 1000;
  const start = Date.now();
  let isBaseline = isFirstEverRun;

  while (true) {
    const { events, errors } = scanOnce({ workspace, ghDir, repo, issue, state, isBaseline, ghOpts });
    for (const e of errors) err.push(`assistant-watch: ${e}`);
    writeState(workspace, issue, state);
    isBaseline = false; // ベースライン確立はループ最初の1サイクルのみ

    if (events.length > 0) {
      for (const e of events) out.push(`EVENT ${JSON.stringify(e)}`);
      return { code: 0, lines: out, errLines: err };
    }

    const elapsed = Date.now() - start;
    if (elapsed >= waitMs) {
      out.push('TIMEOUT');
      return { code: 0, lines: out, errLines: err };
    }
    await _sleep(Math.min(intervalMs, waitMs - elapsed));
  }
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  main().then(({ code, lines, errLines }) => {
    for (const l of errLines) process.stderr.write(l + '\n');
    for (const l of lines) process.stdout.write(l + '\n');
    process.exit(code);
  });
}

module.exports = {
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhIssueComments: (fn) => { _ghIssueComments = fn; },
  _setGhPrList: (fn) => { _ghPrList = fn; },
  _setSleep: (fn) => { _sleep = fn; },
  main,
  parseArgs,
  scanOnce,
  readState,
  writeState,
  statePath,
  extractPreview,
  USAGE,
};
