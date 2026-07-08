#!/usr/bin/env node
// msg-poll.js — GitHub Issue コメントをポーリングして新着メッセージを stdout に通知する
//
// Usage: node msg-poll.js <self> [--issue <N>] [--workspace <path>] [--interval <sec>] [--once]
//
// Output (stdout):
//   worker mode:       NEW_MESSAGE:<commentId>
//   orchestrator mode: NEW_MESSAGE:<issue>:<commentId>
//
// poll-reviews.js と同型の設計。エージェント自身のターン内で
// blocking poll として実行され、detached sidecar にはならない。
//
// カーソルは .gh-maestro/msg-state/<self>.json に永続化される。
// ファイルが無い・壊れている場合は「過去メッセージの再通知」として扱う。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { validateField } = require('./shared/validate');
const {
  resolveSessionPid,
  createDeadManSwitch,
  registerProcess,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');

const DEFAULT_INTERVAL_SEC = 20;
const MARKER_RE = /^<!--\s*gh-maestro\s+(\{.*\})\s*-->/;
const MAX_SEEN_IDS = 100;

const USAGE = `msg-poll.js — GitHub Issue コメントを定期スキャンし新着メッセージを stdout に通知する

Usage: node msg-poll.js <self> [--issue <N>] [--workspace <path>] [--interval <sec>] [--once] [--session-pid <pid>]

Arguments:
  <self>                 自分の名前（worker 名、または "orchestrator"）

Options:
  --issue <N>            監視対象の Issue 番号（worker モードでは必須、orchestrator モードでは指定不要）
  --workspace <path>     ワークスペースパス（省略時は環境変数またはCWDから解決）
  --interval <sec>       ポーリング間隔（秒、既定: ${DEFAULT_INTERVAL_SEC}）
  --once                 1回だけスキャンして終了する（継続ポーリングしない）
  --session-pid <pid>    監視対象のセッションPID（dead-man's switch用。省略時は自動検出）

Output (stdout):
  新着メッセージを1行ずつ出力:
    worker モード:       NEW_MESSAGE:<commentId>
    orchestrator モード: NEW_MESSAGE:<issue>:<commentId>

このスクリプトはエージェントのターン内で blocking 実行される。detached 起動しない。
カーソルは .gh-maestro/msg-state/<self>.json に永続化され、--once の繰り返し実行でも二重通知しない。
state ファイルが壊れている・存在しない場合は「過去メッセージの再通知」として扱う。
gh 呼び出し失敗（ネットワーク断・rate limit 等）はそのサイクルをスキップし次サイクルへ継続する。

ライフサイクル管理:
  ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
  消滅時はPID registryを解除して自動exitする。起動時にPID registryへ自己登録する。`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

const GH_TIMEOUT_MS = 30000;

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

let _ghApiComments = (repo, issue, since, opts = {}) => {
  const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--jq', '.'];
  if (since) {
    args.push('-f', `since=${since}`);
  }
  args.push('-f', 'per_page=100');
  return spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

// ── ヘルパー ──────────────────────────────────────────────────────────────

function statePath(workspace, self) {
  return path.join(workspace, '.gh-maestro', 'msg-state', `${self}.json`);
}

function readState(workspace, self) {
  const sp = statePath(workspace, self);
  try {
    if (!fs.existsSync(sp)) return { since: null, seenIds: [] };
    const raw = fs.readFileSync(sp, 'utf8');
    const parsed = JSON.parse(raw);
    // since は worker モードでは文字列、orchestrator モードではオブジェクト
    return {
      since: parsed.since != null ? parsed.since : null,
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds : [],
    };
  } catch {
    return { since: null, seenIds: [] };
  }
}

function writeState(workspace, self, state) {
  const sp = statePath(workspace, self);
  const dir = path.dirname(sp);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = sp + '.' + Math.random().toString(36).slice(2, 8);
  const seenIds = state.seenIds.slice(-MAX_SEEN_IDS);
  fs.writeFileSync(tmp, JSON.stringify({ since: state.since, seenIds }, null, 2), 'utf8');
  fs.renameSync(tmp, sp);
}

function parseMarker(body) {
  if (!body) return null;
  const firstLine = body.split('\n')[0];
  const m = firstLine.match(MARKER_RE);
  if (!m) return null;
  try {
    const meta = JSON.parse(m[1]);
    if (meta && typeof meta.to === 'string') {
      return meta;
    }
    return null;
  } catch {
    return null;
  }
}

// ── メインロジック ────────────────────────────────────────────────────────

/**
 * 引数バリデーションと初期化を行い、poll 実行に必要なオブジェクトを返す。
 * scanOnce() は初回のスキャン実行前には呼ばれない（呼び出し側が制御する）。
 *
 * @param {string[]} [argsOverride]  省略時は process.argv.slice(2)
 * @param {{ streamOutput?: boolean }} [opts]  streamOutput=true で scanOnce
 *   内の出力をリアルタイムに process.stdout へも流す（継続モード CLI 用）
 * @returns {{
 *   code: number, lines: string[], errLines: string[],
 *   scanOnce: (() => void) | null,   // code !== 0 のときは null
 *   onceMode: boolean,
 *   intervalMs: number,
 * }}
 */
function main(argsOverride, opts = {}) {
  const { streamOutput = false } = opts;
  const out = [];
  const err = [];

  const writeOut = (s) => {
    out.push(s);
    if (streamOutput) process.stdout.write(s + '\n');
  };
  const writeErr = (s) => {
    err.push(s);
    if (streamOutput) process.stderr.write(s + '\n');
  };

  const args = argsOverride || process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err, scanOnce: null, onceMode: true, intervalMs: 0 };
  }

  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--issue', '--interval', '--session-pid']);

  if (exitFlagMiss) {
    writeErr('msg-poll: フラグには値が必要です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const onceMode = rest.includes('--once');
  const positional = rest.filter(a => a !== '--once');
  const self = positional[0];
  const issueArg = values['--issue'];

  if (!self) {
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  // path-safety 検証（queue-path-safety.md 準拠）
  try {
    validateField('self', self);
  } catch (e) {
    writeErr(`msg-poll: ${e.message}`);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  // orchestrator かどうか
  const isOrchestrator = self === 'orchestrator';

  // worker モードでは --issue 必須
  if (!isOrchestrator && !issueArg) {
    writeErr('msg-poll: worker モードでは --issue <N> が必須です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('msg-poll: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const intervalMs = (parseInt(values['--interval'] || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;

  // ── セッションPID解決（dead-man's switch） ────────────────────────────

  const sessionPid = resolveSessionPid(values['--session-pid']);

  // ── リポジトリ解決 ──────────────────────────────────────────────────

  const ghOpts = { cwd: workspace };
  const repoResult = _ghRepoView(ghOpts);
  if (repoResult.status !== 0) {
    writeErr(`msg-poll: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }
  const repo = repoResult.stdout.trim();

  // ── カーソル読み込み ─────────────────────────────────────────────────

  const state = readState(workspace, self);

  // ── dead-man's switch: 毎周回で親セッションの生存を確認 ──────────

  const checkParent = createDeadManSwitch(sessionPid);

  /**
   * 1回のスキャン。
   */
  function scanOnce() {
    // dead-man's switch: 親が死んでいたら cleanup して exit
    if (!checkParent()) {
      lifecycleCleanup(workspace);
      // stderr に理由を出力して exit（stdout は Monitor 通知チャンネルなので使わない）
      process.stderr.write(`msg-poll: parent session (pid ${sessionPid}) is dead — exiting\n`);
      process.exit(0);
    }

    let allIssuesAndComments = [];

    if (isOrchestrator) {
      // orchestrator モード: workers.json から全ワーカーの issue を収集
      // since は Issue ごとの個別ウォーターマーク（オブジェクト）で管理する
      if (typeof state.since !== 'object' || state.since === null || Array.isArray(state.since)) {
        state.since = {};
      }

      const workersPath = path.join(workspace, '.gh-maestro', 'workers.json');
      let workers = {};
      try {
        if (fs.existsSync(workersPath)) {
          const raw = JSON.parse(fs.readFileSync(workersPath, 'utf8'));
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            workers = raw;
          }
        }
      } catch {
        // workers.json が読めない・parse できない → 空扱いで継続
      }

      const issues = new Set();
      for (const entry of Object.values(workers)) {
        if (entry && typeof entry === 'object' && entry.issue) {
          issues.add(String(entry.issue));
        }
      }

      for (const issue of issues) {
        const issueSince = typeof state.since[issue] === 'string' ? state.since[issue] : null;
        const result = _ghApiComments(repo, issue, issueSince, ghOpts);
        if (result.status !== 0) {
          const errMsg = result.error && result.error.code === 'ETIMEDOUT'
            ? `gh api タイムアウト (issue ${issue})`
            : `gh api エラー (issue ${issue}): ${result.stderr || result.error?.message || '(empty)'}`;
          writeErr(`msg-poll: ${errMsg}`);
          continue;
        }
        let comments;
        try {
          comments = JSON.parse(result.stdout || '[]');
        } catch {
          writeErr(`msg-poll: JSON parse エラー (issue ${issue})`);
          continue;
        }
        if (!Array.isArray(comments)) {
          writeErr(`msg-poll: gh api の応答が配列ではありません (issue ${issue})`);
          continue;
        }
        for (const c of comments) {
          allIssuesAndComments.push({ issue, comment: c });
        }
      }
    } else {
      // worker モード: state.since は文字列
      const workerSince = typeof state.since === 'string' ? state.since : null;
      const result = _ghApiComments(repo, issueArg, workerSince, ghOpts);
      if (result.status !== 0) {
        const errMsg = result.error && result.error.code === 'ETIMEDOUT'
          ? 'gh api タイムアウト'
          : `gh api エラー: ${result.stderr || result.error?.message || '(empty)'}`;
        writeErr(`msg-poll: ${errMsg}`);
        return;
      }
      let comments;
      try {
        comments = JSON.parse(result.stdout || '[]');
      } catch {
        writeErr('msg-poll: JSON parse エラー');
        return;
      }
      if (!Array.isArray(comments)) {
        writeErr('msg-poll: gh api の応答が配列ではありません');
        return;
      }
      for (const c of comments) {
        allIssuesAndComments.push({ issue: issueArg, comment: c });
      }
    }

    // ── カーソルを全コメントの最大 created_at まで進める ─────────────────
    // マッチしなかったコメントもカーソルを進めることで、無関係なコメントが
    // 100件を超えても自分宛メッセージを見失わない（ページネーション対策）。

    for (const { issue, comment: c } of allIssuesAndComments) {
      if (c.created_at) {
        if (isOrchestrator) {
          if (!state.since[issue] || c.created_at > state.since[issue]) {
            state.since[issue] = c.created_at;
          }
        } else {
          if (!state.since || c.created_at > state.since) {
            state.since = c.created_at;
          }
        }
      }
    }

    // ── 新着フィルタリング ──────────────────────────────────────────────

    const newSeenIds = [...state.seenIds];

    for (const { issue, comment: c } of allIssuesAndComments) {
      const cid = c.id;
      if (cid == null) continue;

      // 既知の ID はスキップ
      if (state.seenIds.includes(cid)) continue;

      const meta = parseMarker(c.body);
      if (!meta) continue; // マーカーなし・JSON parse 失敗は無視

      if (meta.to !== self) continue; // 自分宛てでない

      // 新着通知
      if (isOrchestrator) {
        writeOut(`NEW_MESSAGE:${issue}:${cid}`);
      } else {
        writeOut(`NEW_MESSAGE:${cid}`);
      }

      newSeenIds.push(cid);
    }

    // ── カーソル永続化 ─────────────────────────────────────────────────
    state.seenIds = newSeenIds.slice(-MAX_SEEN_IDS);
    writeState(workspace, self, state);
  }

  return {
    code: 0,
    lines: out,
    errLines: err,
    scanOnce,
    onceMode,
    intervalMs,
    workspace,
    sessionPid,
  };
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const isContinuous = !process.argv.slice(2).includes('--once');
  // 継続モードでは scanOnce の出力をリアルタイムに stdout へ流す
  const result = main(undefined, { streamOutput: isContinuous });

  // 初期エラー／help はここで出力
  for (const l of result.errLines) process.stderr.write(l + '\n');

  if (result.code !== 0) {
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(result.code);
  }

  if (result.scanOnce === null) {
    // --help
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  const sc = result.scanOnce;

  if (result.onceMode) {
    sc();
    // streamOutput が false なので lines に収集されている
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  // ── PID registry に自己登録（継続モードのみ） ──────────────────────

  registerProcess(result.workspace, { script: 'msg-poll.js' });

  // 継続モード: streamOutput が true なので scanOnce の出力は直接 stdout へ出る
  let intervalHandle = null;

  function cleanup() {
    if (intervalHandle) clearInterval(intervalHandle);
    lifecycleCleanup(result.workspace);
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  sc();
  intervalHandle = setInterval(sc, result.intervalMs);
  // interval は unref しない — イベントループを維持する
}

// ── テスト用 export ──────────────────────────────────────────────────────

module.exports = {
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhApiComments: (fn) => { _ghApiComments = fn; },
  main,
  // 内部ロジックの単体テスト用
  parseMarker,
  readState,
  writeState,
  statePath,
  MARKER_RE,
  USAGE,
};
