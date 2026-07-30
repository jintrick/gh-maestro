#!/usr/bin/env node
// msg-poll.js — GitHub Issue コメントをポーリングして新着メッセージを stdout に通知する
//
// Usage: node msg-poll.js <self> [--issue <N>] [--workspace <path>] [--interval <sec>] [--once | --wait <sec>]
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
const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { validateField } = require('./shared/validate');
const { isRetryableGhFailure, graphqlListComments } = require('./shared/gh-fallback');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const {
  resolveSessionPid,
  createDeadManSwitch,
  registerProcess,
  findRunningInstance,
  acquireStartupLock,
  releaseStartupLock,
  cleanup: lifecycleCleanup,
  isProcessAlive,
} = require('./process-lifecycle');

const DEFAULT_INTERVAL_SEC = 20;
const MARKER_RE = /^<!--\s*gh-maestro\s+(\{.*\})\s*-->/;
const MAX_SEEN_IDS = 100;

const USAGE = `msg-poll.js — GitHub Issue コメントを定期スキャンし新着メッセージを stdout に通知する

Usage: node msg-poll.js <self> [--issue <N>] [--workspace <path>] [--interval <sec>] [--once | --wait <sec>] [--session-pid <pid>] [--force]
       node msg-poll.js --watch-pid <pid> [--interval <sec>]

Arguments:
  <self>                 自分の名前（worker 名、または "orchestrator"）

Options:
  --issue <N>            監視対象の Issue 番号（worker モードでは必須、orchestrator モードでは指定不要）
  --workspace <path>     ワークスペースパス（省略時は環境変数またはCWDから解決）
  --interval <sec>       ポーリング間隔（秒、既定: ${DEFAULT_INTERVAL_SEC}）
  --once                 1回だけスキャンして終了する（継続ポーリングしない）
  --wait <sec>           新着メッセージを1件検出するか、指定秒数が経過するまでフォアグラウンドで
                          待機する（内部的には --interval 秒間隔でリトライする）。新着を1件検出した
                          時点、またはタイムアウト時点のいずれか早い方で exit code 0 で終了する。
                          新着が複数件たまっていても、1回の呼び出しで出力・既読化されるのは
                          最も古い1件のみ。残りは次回の --wait 呼び出しで改めて返される。
                          --once と同時指定はできない（エラー終了する）。
                          継続モードと同様にPID registryへ自己登録し、終了時に解除する。
  --session-pid <pid>    監視対象のセッションPID（dead-man's switch用。省略時は自動検出）
  --force                同じ self を既に監視している生存プロセスがいても起動を強制する
                          （継続モード・--wait モードのみ有効。既定では多重起動を検知して exit 1 する）
  --watch-pid <pid>      他の <self> 引数を無視し、指定PIDの生存監視のみを行う特殊モード。
                          「重複起動を検出しました」エラー時に代替コマンドとして案内される
                          （このモードは msg-poll.js 自身を起動するかどうかの判断を必要としない）。
                          PIDが生存している間は何も出力しない。死亡を検知した時点で
                          \`PID_DIED:<pid>\` を1行出力して exit 0 する。Monitorのcommandに
                          そのまま渡すことを想定している。PID registryへの自己登録は行わない
                          （監視対象そのものではなくその健全性を見ているだけのため）。

Output (stdout):
  新着メッセージを1行ずつ出力:
    worker モード:       NEW_MESSAGE:<commentId>
    orchestrator モード: NEW_MESSAGE:<issue>:<commentId>
  --watch-pid モード:    PID_DIED:<pid>（監視対象PIDの死亡を検知した1回のみ）

このスクリプトはエージェントのターン内で blocking 実行される。detached 起動しない。
カーソルは .gh-maestro/msg-state/<self>.json に永続化され、--once/--wait の繰り返し実行でも二重通知しない。
state ファイルが壊れている・存在しない場合は「過去メッセージの再通知」として扱う。
gh 呼び出し失敗（ネットワーク断・rate limit 等）はそのサイクルをスキップし次サイクルへ継続する。

ライフサイクル管理:
  ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
  消滅時はPID registryを解除して自動exitする。継続モード・--wait モードは起動時にPID registryへ自己登録する。`;

/**
 * 「重複起動を検出しました」エラー時に案内する、既存PIDを監視するための
 * 代替コマンド文字列を組み立てる。
 *
 * @param {number} pid
 * @param {string|null} [intervalSec]
 * @returns {string}
 */
function buildWatchPidCommand(pid, intervalSec) {
  const parts = ['node', JSON.stringify(__filename), '--watch-pid', String(pid)];
  if (intervalSec) parts.push('--interval', String(intervalSec));
  return parts.join(' ');
}

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

const GH_TIMEOUT_MS = 30000;

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...opts });
};

let _ghApiComments = (repo, issue, since, opts = {}) => {
  const callOpts = { ...opts, per_page: 100 };
  if (since) callOpts.since = since;
  const restResult = listComments(repo, issue, callOpts);

  if (restResult.status === 0 || !isRetryableGhFailure(restResult)) {
    return restResult;
  }

  process.stderr.write('msg-poll: REST API失敗のためGraphQLにフォールバックします\n');
  return graphqlListComments({ repo, issue, since, opts: { timeout: GH_TIMEOUT_MS, ...opts } });
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

// ── 引数解析（main() と CLI プリフライトの両方から共有） ──────────────────

/**
 * CLI引数を解析する。main() と CLI エントリポイントの多重起動プリフライトチェックが
 * 別々に parseFlags を呼び直すと解析ロジックが乖離するため、ここに一本化する。
 *
 * @param {string[]} args
 * @returns {{
 *   help: boolean, exitFlagMiss: boolean,
 *   self?: string, issueArg?: string|null, workspaceArg?: string|null,
 *   intervalArg?: string|null, sessionPidArg?: string|null,
 *   onceMode?: boolean, force?: boolean, waitArg?: string|null,
 * }}
 */
function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true, exitFlagMiss: false };
  }

  const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace', '--issue', '--interval', '--session-pid', '--wait']);
  if (exitFlagMiss) {
    return { help: false, exitFlagMiss: true };
  }

  const onceMode = rest.includes('--once');
  const force = rest.includes('--force');
  const positional = rest.filter(a => a !== '--once' && a !== '--force');

  return {
    help: false,
    exitFlagMiss: false,
    self: positional[0],
    issueArg: values['--issue'],
    workspaceArg: values['--workspace'],
    intervalArg: values['--interval'],
    sessionPidArg: values['--session-pid'],
    onceMode,
    force,
    waitArg: values['--wait'],
  };
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
  const parsed = parseArgs(args);

  if (parsed.help) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err, scanOnce: null, onceMode: true, intervalMs: 0 };
  }

  if (parsed.exitFlagMiss) {
    writeErr('msg-poll: フラグには値が必要です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const { self, issueArg, onceMode, force, waitArg } = parsed;

  if (onceMode && waitArg != null) {
    writeErr('msg-poll: --once と --wait は同時指定できません。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const waitMode = !onceMode && waitArg != null;
  let waitMs = 0;
  if (waitMode) {
    const parsedWait = parseInt(waitArg, 10);
    if (!Number.isFinite(parsedWait) || parsedWait <= 0) {
      writeErr(`msg-poll: --wait には正の整数（秒）を指定してください: ${waitArg}`);
      writeErr(USAGE);
      return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
    }
    waitMs = parsedWait * 1000;
  }

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

  const workspace = resolveWorkspace(parsed.workspaceArg);
  if (!workspace) {
    writeErr('msg-poll: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err, scanOnce: null, onceMode: false, intervalMs: 0 };
  }

  const intervalMs = (parseInt(parsed.intervalArg || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;

  // ── セッションPID解決（dead-man's switch） ────────────────────────────

  const sessionPid = resolveSessionPid(parsed.sessionPidArg);

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
   *
   * @param {{ maxGhTimeoutMs?: number, singleMessage?: boolean }} [opts]
   *   maxGhTimeoutMs: gh 呼び出しの上限タイムアウト（ms）。
   *   --wait モードで締切間際に呼ばれた場合、既定の GH_TIMEOUT_MS（30秒）を待つと
   *   --wait で指定した秒数を大幅に超過しうるため、残り時間に応じて上限を絞り込む。
   *   （最低 1000ms は確保する。0 以下を spawnSync の timeout に渡すとタイムアウトが
   *   無効化されてしまうため）
   *   singleMessage: true の場合、新着が複数件あっても最も古い1件のみを
   *   NEW_MESSAGE として出力・既読化する（--wait モード専用）。残りは
   *   次回呼び出しのために未読のまま残し、カーソル（since）もその1件の
   *   created_at を超えて進めない（進めると gh api の since フィルタで
   *   未処理分が再取得できなくなるため）。
   */
  function scanOnce(opts = {}) {
    const { maxGhTimeoutMs, singleMessage = false } = opts;
    const callOpts = maxGhTimeoutMs != null
      ? { cwd: workspace, timeout: Math.min(GH_TIMEOUT_MS, Math.max(1000, maxGhTimeoutMs)) }
      : ghOpts;

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
        const result = _ghApiComments(repo, issue, issueSince, callOpts);
        if (result.status !== 0) {
          const errMsg = result.error && result.error.code === 'ETIMEDOUT'
            ? `gh api タイムアウト (issue ${issue})`
            : `gh api エラー (issue ${issue}): ${result.stderr || result.error?.message || '(empty)'}`;
          writeErr(`msg-poll: ${errMsg}`);
          continue;
        }
        let comments;
        try {
          comments = parseCommentsResponse(result.stdout);
        } catch {
          writeErr(`msg-poll: JSON parse エラー (issue ${issue})`);
          continue;
        }
        if (comments === null) {
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
      const result = _ghApiComments(repo, issueArg, workerSince, callOpts);
      if (result.status !== 0) {
        const errMsg = result.error && result.error.code === 'ETIMEDOUT'
          ? 'gh api タイムアウト'
          : `gh api エラー: ${result.stderr || result.error?.message || '(empty)'}`;
        writeErr(`msg-poll: ${errMsg}`);
        return;
      }
      let comments;
      try {
        comments = parseCommentsResponse(result.stdout);
      } catch {
        writeErr('msg-poll: JSON parse エラー');
        return;
      }
      if (comments === null) {
        writeErr('msg-poll: gh api の応答が配列ではありません');
        return;
      }
      for (const c of comments) {
        allIssuesAndComments.push({ issue: issueArg, comment: c });
      }
    }

    // ── 初回スキャンのサイレント catch-up（orchestrator モード） ────
    // state.since[issue] が未設定の Issue（初回スキャン）では、全コメントを
    // NEW_MESSAGE として出力せずに seenIds に追加する（サイレント catch-up）。
    // カーソル（since）は後続の cursor advancement で自動的に進む。
    // 重複判定は Set で O(1) に行い、最終的に seenIds 配列へマージする。
    if (isOrchestrator) {
      const seenSet = new Set(state.seenIds);
      for (const { issue, comment: c } of allIssuesAndComments) {
        const issueSince = typeof state.since[issue] === 'string' ? state.since[issue] : null;
        if (issueSince !== null) continue;
        const cid = c.id;
        if (cid != null) seenSet.add(cid);
      }
      state.seenIds = [...seenSet].slice(-MAX_SEEN_IDS);
    }

    // ── 新着候補の抽出 ──────────────────────────────────────────────────
    // 自分宛て・未読のコメントを issue ごとに集める。

    const candidatesByIssue = new Map(); // issue -> [{ cid, created_at, issue }]
    for (const { issue, comment: c } of allIssuesAndComments) {
      const cid = c.id;
      if (cid == null) continue;
      if (state.seenIds.includes(cid)) continue; // 既知の ID はスキップ
      // created_at 欠落は、下流の created_at ソート・カーソル計算
      // （maxCreatedByIssue 等）と扱いを揃え、除外する。
      if (!c.created_at) continue;

      const meta = parseMarker(c.body);
      if (!meta) continue; // マーカーなし・JSON parse 失敗は無視
      if (meta.to !== self) continue; // 自分宛てでない

      if (!candidatesByIssue.has(issue)) candidatesByIssue.set(issue, []);
      candidatesByIssue.get(issue).push({ cid, created_at: c.created_at, issue });
    }

    const allCandidates = [];
    for (const arr of candidatesByIssue.values()) allCandidates.push(...arr);
    allCandidates.sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return a.cid - b.cid;
    });

    // singleMessage: 最も古い1件のみを出力・既読化する。残りは次回に持ち越す。
    const emitted = singleMessage ? allCandidates.slice(0, 1) : allCandidates;
    const emittedIds = new Set(emitted.map((e) => e.cid));

    for (const e of emitted) {
      if (isOrchestrator) {
        writeOut(`NEW_MESSAGE:${e.issue}:${e.cid}`);
      } else {
        writeOut(`NEW_MESSAGE:${e.cid}`);
      }
    }

    const newSeenIds = [...state.seenIds, ...emitted.map((e) => e.cid)];
    state.seenIds = newSeenIds.slice(-MAX_SEEN_IDS);

    // issue ごとに「持ち越した（出力しなかった）新着候補」が存在するかどうか。
    const issuesWithDeferred = new Set();
    for (const [issue, arr] of candidatesByIssue) {
      if (arr.some((e) => !emittedIds.has(e.cid))) {
        issuesWithDeferred.add(issue);
      }
    }

    // ── カーソルを進める ───────────────────────────────────────────────
    // マッチしなかったコメントもカーソルを進めることで、無関係なコメントが
    // 100件を超えても自分宛メッセージを見失わない（ページネーション対策）。
    // ただし、その issue に持ち越した新着候補がある場合はカーソルを一切
    // 進めない。GitHub の issue-comments API の since フィルタが
    // 境界時刻を含む（inclusive）か含まないか（exclusive）は保証されて
    // いないため、持ち越し分の created_at ちょうどにカーソルを合わせる
    // （境界値に依存する）方式は取らない。次回の呼び出しでも今回と全く
    // 同じ since で再取得し、seenIds で重複を弾く。

    const maxCreatedByIssue = new Map();
    for (const { issue, comment: c } of allIssuesAndComments) {
      if (!c.created_at) continue;
      const cur = maxCreatedByIssue.get(issue);
      if (!cur || c.created_at > cur) maxCreatedByIssue.set(issue, c.created_at);
    }

    for (const [issue, maxCreated] of maxCreatedByIssue) {
      if (issuesWithDeferred.has(issue)) continue;

      if (isOrchestrator) {
        // state.since[issue] が文字列でない（破損した state ファイル等に
        // 由来する）場合は不正な値として扱い、無条件に上書きする。
        // typeof チェックを省略すると `{}` 等のtruthyな非文字列値で
        // `!state.since[issue]` が false のままカーソルが永久に固着する。
        const cur = typeof state.since[issue] === 'string' ? state.since[issue] : null;
        if (!cur || maxCreated > cur) {
          state.since[issue] = maxCreated;
        }
      } else {
        const cur = typeof state.since === 'string' ? state.since : null;
        if (!cur || maxCreated > cur) {
          state.since = maxCreated;
        }
      }
    }

    // ── カーソル永続化 ─────────────────────────────────────────────────
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
    self,
    force,
    waitMode,
    waitMs,
  };
}

// ── --wait モード ────────────────────────────────────────────────────────

let _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * --wait モード: 新着メッセージを検出するか waitMs が経過するまで、
 * scanOnce を intervalMs 間隔でリトライする。
 *
 * @param {{ scanOnce: (opts?: { maxGhTimeoutMs?: number, singleMessage?: boolean }) => void, lines: string[], intervalMs: number, waitMs: number }} result
 *   main() の戻り値（waitMode: true のもの）
 * @returns {Promise<boolean>} 新着を検出すれば true、タイムアウトなら false
 */
async function runWaitMode(result) {
  const { scanOnce, lines, intervalMs, waitMs } = result;
  const start = Date.now();
  while (true) {
    const before = lines.length;
    // gh 呼び出しの上限を残り時間に絞り、--wait の締切超過を最小化する
    const remainingForGh = Math.max(0, waitMs - (Date.now() - start));
    // --wait は1回の呼び出しで常に高々1件しか返さない契約（Issue #99）
    scanOnce({ maxGhTimeoutMs: remainingForGh, singleMessage: true });
    if (lines.length > before) return true;
    const elapsed = Date.now() - start;
    if (elapsed >= waitMs) return false;
    const remaining = waitMs - elapsed;
    await _sleep(Math.min(intervalMs, remaining));
  }
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);

  // ── --watch-pid: 既存の生存プロセスを監視するだけの軽量モード ──────────
  // <self> 等の他の引数を必要としない、完全に独立したモード。
  // 「重複起動を検出しました」時の代替コマンドとして案内される。
  if (rawArgs.includes('--watch-pid')) {
    const { values: watchValues, exitFlagMiss: watchExitFlagMiss } =
      parseFlags(rawArgs, ['--watch-pid', '--interval']);
    if (watchExitFlagMiss) {
      process.stderr.write('msg-poll: フラグには値が必要です。\n');
      process.exit(1);
    }
    const watchPid = parseInt(watchValues['--watch-pid'], 10);
    if (!Number.isFinite(watchPid) || watchPid <= 0) {
      process.stderr.write(`msg-poll: --watch-pid には正の整数のPIDを指定してください: ${watchValues['--watch-pid']}\n`);
      process.exit(1);
    }
    const watchIntervalMs = (parseInt(watchValues['--interval'] || String(DEFAULT_INTERVAL_SEC)) || DEFAULT_INTERVAL_SEC) * 1000;

    const checkWatchedPid = () => {
      if (!isProcessAlive(watchPid)) {
        process.stdout.write(`PID_DIED:${watchPid}\n`);
        process.exit(0);
      }
    };
    checkWatchedPid();
    const watchIntervalHandle = setInterval(checkWatchedPid, watchIntervalMs);
    process.on('SIGINT', () => { clearInterval(watchIntervalHandle); process.exit(0); });
    process.on('SIGTERM', () => { clearInterval(watchIntervalHandle); process.exit(0); });
    return;
  }

  // main() と同じ parseArgs() を再利用する（解析ロジックを2箇所に分けない）。
  const parsedForCli = parseArgs(rawArgs);
  const isWait = !parsedForCli.help && !parsedForCli.exitFlagMiss && !parsedForCli.onceMode && parsedForCli.waitArg != null;
  const isContinuous = !parsedForCli.help && !parsedForCli.exitFlagMiss && !parsedForCli.onceMode && !isWait;

  // ── 単一起動ロック + 多重起動検知（継続モード・--wait モードのみ、main() 本体の gh 呼び出しより前に行う） ──
  // main() は self/workspace 解決の直後に gh repo view を実行するため、
  // ここで先にロック取得・重複検知を行う（無駄な gh 呼び出しを避ける）。
  //
  // findRunningInstance（チェック）→ registerProcess（登録）だけでは非アトミックで、
  // ほぼ同時に2プロセスが起動すると両方がチェックを通過しうる（TOCTOU）。
  // acquireStartupLock で「チェック開始〜登録完了」の区間を排他化する。
  let lockWorkspace = null;
  let lockWorkerName = null;
  let lockHeld = false;

  function releaseCliLock() {
    if (lockHeld && lockWorkspace !== null) {
      releaseStartupLock(lockWorkspace, 'msg-poll.js', lockWorkerName);
      lockHeld = false;
    }
  }

  if ((isContinuous || isWait) && !parsedForCli.force && parsedForCli.self) {
    const preWorkspace = resolveWorkspace(parsedForCli.workspaceArg);
    if (preWorkspace) {
      const workerNameForRegistry = parsedForCli.self !== 'orchestrator' ? parsedForCli.self : null;

      if (!acquireStartupLock(preWorkspace, 'msg-poll.js', workerNameForRegistry)) {
        process.stderr.write(
          `msg-poll: 別のプロセスが同じ inbox（self=${parsedForCli.self}）の起動処理中です。` +
          '少し待つか既存のMonitorを使い回してください。\n'
        );
        process.exit(1);
      }
      lockWorkspace = preWorkspace;
      lockWorkerName = workerNameForRegistry;
      lockHeld = true;

      const dup = findRunningInstance(preWorkspace, { script: 'msg-poll.js', workerName: workerNameForRegistry });
      if (dup) {
        process.stderr.write(
          `msg-poll: 重複起動を検出しました。既に pid=${dup.pid} が同じ inbox（self=${parsedForCli.self}）に登録されています。新規プロセスは起動しません。\n` +
          `代わりに以下をMonitorでpersistent:trueとして起動してください（このコマンドをそのまま使うこと。判断は不要）:\n` +
          `  ${buildWatchPidCommand(dup.pid)}\n` +
          `このコマンドは pid=${dup.pid} の生存を監視し続け、死亡時に \`PID_DIED:${dup.pid}\` を通知します。` +
          `その通知を受け取ったら、そのときはじめて改めてこのコマンドを --force なしで起動し直してください。\n`
        );
        releaseCliLock();
        process.exit(1);
      }
    }
  }

  // 継続モード・--wait モードでは scanOnce の出力をリアルタイムに stdout へ流す
  const result = main(undefined, { streamOutput: isContinuous || isWait });

  // 初期エラー／help はここで出力
  for (const l of result.errLines) process.stderr.write(l + '\n');

  if (result.code !== 0) {
    releaseCliLock();
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(result.code);
  }

  if (result.scanOnce === null) {
    // --help
    releaseCliLock();
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  const sc = result.scanOnce;

  if (result.onceMode) {
    releaseCliLock();
    sc();
    // streamOutput が false なので lines に収集されている
    for (const l of result.lines) process.stdout.write(l + '\n');
    process.exit(0);
  }

  // ── PID registry に自己登録（継続モード・--wait モード） ────────────
  // worker モードの場合は workerName を含めて登録する。
  // これにより remove-worker.js の sweep が entry.workerName でマッチできる。

  registerProcess(result.workspace, {
    script: 'msg-poll.js',
    workerName: result.self !== 'orchestrator' ? result.self : null,
  });

  // registry への登録が完了したので単一起動ロックを解放する
  // （以後の重複検知は registry の生存確認だけで足りる）
  releaseCliLock();

  if (result.waitMode) {
    // --wait モード: 新着検出 or タイムアウトのいずれか早い方で exit 0 する。
    // streamOutput が true なので scanOnce の出力は直接 stdout へ出る。
    function cleanupWait() {
      lifecycleCleanup(result.workspace);
      releaseCliLock();
    }

    process.on('SIGINT', () => { cleanupWait(); process.exit(0); });
    process.on('SIGTERM', () => { cleanupWait(); process.exit(0); });

    runWaitMode(result).then(() => {
      cleanupWait();
      process.exit(0);
    });

    return;
  }

  // 継続モード: streamOutput が true なので scanOnce の出力は直接 stdout へ出る
  let intervalHandle = null;

  function cleanup() {
    if (intervalHandle) clearInterval(intervalHandle);
    lifecycleCleanup(result.workspace);
    releaseCliLock();
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
  _setSleep: (fn) => { _sleep = fn; },
  main,
  runWaitMode,
  // 内部ロジックの単体テスト用
  parseArgs,
  parseMarker,
  parseCommentsResponse,
  readState,
  writeState,
  statePath,
  buildWatchPidCommand,
  MARKER_RE,
  USAGE,
};
