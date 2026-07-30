#!/usr/bin/env node
'use strict';
// worker-exit-hook.js
// 全ワーカーの onExit フック（spawn-worker.js / inbox-supervisor.js が起動コマンド末尾に仕込む）。
// エージェントプロセスが終了した直後に、その終了コードを引数末尾に付けて呼ばれる。
//   1. execution-id 付き（architect 等）なら executions.json に終了を記録する
//   2. 非ゼロ終了なら orchestrator へ「異常終了」を通知する（サイレント失敗を潰す）
//   3. resumeでの起動（log-path・since-timestamp・log-offset 付き）なら、実際にGitHubへ返信
//      （msg-send.js経由の投稿）が届いたかを確認し、届いていなければキャプチャしておいた
//      標準出力を代理送信する。ただし、応答契約（contract）が artifact-or-message で
//      指定成果物（PR）が成立している場合は、代理送信を抑制する。
//      （実障害: コーダーがresumeで正しく考えて回答を作ったのに
//      msg-send.jsを一度も呼ばずに終了し、回答がどこにも投稿されなかった。エージェント種別に
//      依存せず全ワーカー共通のこの経路で、モデルの記憶に頼らず機械的に保証する）。
//
// このフックは GH_MAESTRO_WORKER 環境変数のワーカーコンテキストで走るため、msg-send.js は
// 自動的に from=ワーカー / to=orchestrator として投稿する（成りすまし・宛先誤りは起きない）。
//
// Usage (フック側が仕込む固定形):
//   node worker-exit-hook.js <workspace> <execution-id|""> [<log-path> <since-timestamp> <log-offset> [<contract-spec-json>]] <exit-code>
//   log-path/since-timestamp/log-offset は resume 起動（inbox-supervisor.js）時のみ渡される。
//   新規起動（spawn-worker.js）では渡されず、3.は動作しない。
//   contract-spec-json は応答契約（artifact-or-message 等）のJSON文字列。resume時のみ。
//   存在しないか空文字列の場合は従来通り message-required として動作する。
//   log-offset は「今回のresume分がログのどこから始まるか」のバイト位置。ワーカーのログは
//   1ワーカー1ファイルに追記され続けるため、これが無いと今回何も出力しなかった場合に
//   前回の実行の出力を今回の応答として代理送信してしまう。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', timeout: 30000, ...opts });
};

let _ghApiComments = (repo, issue, since, opts = {}) => {
  const callOpts = { ...opts, per_page: 100 };
  if (since) callOpts.since = since;
  return listComments(repo, issue, callOpts);
};

let _ghPrList = (repo, headBranch, opts = {}) => {
  return spawnSync('gh', [
    'pr', 'list', '--repo', repo,
    '--head', headBranch,
    '--state', 'open',
    '--json', 'number,createdAt',
  ], { encoding: 'utf8', timeout: 30000, ...opts });
};

// msg-send.js自身が「本文は位置引数で渡せない」ガードを持つ（--stdin/--body-fileのみ許可。
// 過去にバッククォート/$入りの本文が位置引数のままbashに解釈され黙って壊れた事故に由来）。
// ここから呼ぶ場合も同じ規約に従い、本文はspawnSyncのinputでstdin経由に渡す。
function buildMsgSendRelayArgs(workspace) {
  return [path.join(__dirname, 'msg-send.js'), '--stdin', '--workspace', workspace];
}

let _relayMessage = (workspace, body) => {
  return spawnSync(process.execPath, buildMsgSendRelayArgs(workspace), { encoding: 'utf8', input: body });
};

const MAX_RELAY_CHARS = 8000;

/**
 * resume区間内にPRが新規作成されたかを確認する。
 *
 * `gh pr list --head <workerBranch>` で完全一致検索し、
 * createdAt が sinceTimestamp 以降のPRが1件でもあれば true を返す。
 * API障害・パース失敗等は false を返す（フェイルセーフ: 代理送信にフォールバック）。
 *
 * @param {object} params
 * @param {string} params.repo
 * @param {string} params.workerBranch - workerName をそのままブランチ名として使う
 * @param {string} params.sinceTimestamp
 * @returns {boolean}
 */
function checkPrCreatedDuringResume({ repo, workerBranch, sinceTimestamp }) {
  const result = _ghPrList(repo, workerBranch);
  if (result.status !== 0) {
    process.stderr.write(`worker-exit-hook: PR検索に失敗: ${result.stderr || '(empty)'}\n`);
    return false;
  }

  let prs;
  try {
    prs = JSON.parse(result.stdout || '[]');
  } catch {
    process.stderr.write('worker-exit-hook: PR検索結果のJSON parseに失敗\n');
    return false;
  }
  if (!Array.isArray(prs)) return false;

  return prs.some((pr) => {
    if (!pr.createdAt) return false;
    return pr.createdAt > sinceTimestamp;
  });
}

/**
 * resumeで配送したメッセージに対して、実際にGitHubへ返信（msg-send.js経由の投稿）が
 * 届いたかを確認する。届いていなければ、キャプチャしておいた標準出力の末尾を代理送信する。
 *
 * 応答契約（contract）が artifact-or-message の場合、返信が無くても
 * sinceTimestamp 以降に新規PRが成立していれば契約充足とみなし、代理送信を抑制する。
 *
 * @param {object} params
 * @param {string} params.workspace
 * @param {string} params.workerName
 * @param {string} params.captureLogPath
 * @param {string} params.sinceTimestamp
 * @param {number} [params.logOffset=0] 今回のresume分がログのどこから始まるか（バイト位置）
 * @param {object|null} [params.contract=null] 応答契約（response-contract.js 参照）。nullの場合は message-required
 */
function verifyReplyAndRelayIfMissing({ workspace, workerName, captureLogPath, sinceTimestamp, logOffset = 0, contract = null }) {
  const issueMatch = /^issue-(\d+)-/.exec(workerName);
  if (!issueMatch) {
    process.stderr.write(`worker-exit-hook: workerName "${workerName}" からIssue番号を導出できません\n`);
    return;
  }
  const issue = issueMatch[1];

  const repoResult = _ghRepoView({ cwd: workspace });
  if (repoResult.status !== 0) {
    process.stderr.write(`worker-exit-hook: リポジトリを解決できません: ${repoResult.stderr || '(empty)'}\n`);
    return;
  }
  const repo = repoResult.stdout.trim();
  if (!repo) return;

  const commentsResult = _ghApiComments(repo, issue, sinceTimestamp, { cwd: workspace });
  if (commentsResult.status !== 0) {
    process.stderr.write(`worker-exit-hook: コメント取得に失敗: ${commentsResult.stderr || '(empty)'}\n`);
    return;
  }

  const { parseMarker } = require('./msg-poll');
  let comments;
  try {
    comments = parseCommentsResponse(commentsResult.stdout);
  } catch {
    process.stderr.write('worker-exit-hook: コメントのJSON parseに失敗\n');
    return;
  }
  if (!Array.isArray(comments)) return;

  // sinceTimestamp以降に、このワーカー自身からの投稿があるかを確認する。
  // gh api の since はサーバー側フィルタだが、境界がinclusive/exclusiveかAPI仕様で
  // 保証されないため、client側でも created_at で二重に確認する。
  const hasReply = comments.some((c) => {
    if (!c.created_at || c.created_at <= sinceTimestamp) return false;
    const meta = parseMarker(c.body);
    return !!meta && meta.from === workerName;
  });

  if (hasReply) return;

  // artifact-or-message 契約の評価: PR が成立していれば契約充足 → 代理送信しない
  if (contract && contract.type === 'artifact-or-message' && contract.artifact === 'pr') {
    const effectiveSince = contract.sinceTimestamp || sinceTimestamp;
    const prCreated = checkPrCreatedDuringResume({
      repo,
      workerBranch: workerName,
      sinceTimestamp: effectiveSince,
    });
    if (prCreated) {
      // PR 成立により契約充足 → 代理送信を抑制
      return;
    }
  }

  // 契約未充足 → 従来の代理送信
  let captured;
  try {
    captured = fs.readFileSync(captureLogPath, 'utf8');
  } catch {
    process.stderr.write(`worker-exit-hook: capture log "${captureLogPath}" を読めません（代理送信スキップ）\n`);
    return;
  }
  const trimmed = captured.trim();
  if (!trimmed) {
    process.stderr.write('worker-exit-hook: capture logが空のため代理送信スキップ\n');
    return;
  }

  const tail = trimmed.length > MAX_RELAY_CHARS ? trimmed.slice(-MAX_RELAY_CHARS) : trimmed;
  const body = `⚠️ [自動代理送信: resumeへの応答としてmsg-send.jsが実行された形跡が無かったため、直前の出力をそのまま送信しています]\n\n${tail}`;

  const relayResult = _relayMessage(workspace, body);
  if (relayResult.status !== 0) {
    process.stderr.write(`worker-exit-hook: 代理送信に失敗: ${(relayResult.stderr || '').trim()}\n`);
  }
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

if (require.main === module) {
  const rawArgs = process.argv.slice(2);
  const [workspace, executionId, captureLogPath, sinceTimestamp, logOffsetRaw, exitCodeRaw, contractSpecRaw] = rawArgs;
  // resumeでは6引数（workspace, executionId, logPath, sinceTimestamp, logOffset, exitCode）、
  // resume+contractでは7引数（上記+contractSpecRaw）。
  // 新規起動では3引数（workspace, executionId, exitCode）で呼ばれる。後者では
  // captureLogPath の位置に exitCode が来るため、引数の個数で判別する。
  const isResumeInvocation = rawArgs.length >= 6;
  const resolvedExitCodeRaw = isResumeInvocation ? exitCodeRaw : captureLogPath;
  const exitCode = parseInt(resolvedExitCodeRaw, 10);
  const workerName = process.env.GH_MAESTRO_WORKER || null;

  // 1. execution 記録（--execution-id 付きの起動のときだけ）
  if (workspace && executionId) {
    try {
      const { markProcessExit } = require('./shared/execution-registry');
      markProcessExit(workspace, executionId, resolvedExitCodeRaw);
    } catch (error) {
      process.stderr.write(`worker-exit-hook: execution 記録失敗: ${error.message}\n`);
    }
  }

  // 2. 非ゼロ終了は orchestrator へ通知する。正常終了（exit 0。セッション再開系ワーカーの
  //    1ターン完了を含む）は通知しない。
  if (Number.isFinite(exitCode) && exitCode !== 0 && workerName && workspace) {
    const body = `⚠️ 起動失敗または異常終了: exit code ${exitCode}。このワーカーのプロセスが正常に完了せず終了しました（起動時のエラーの可能性）。`;
    const r = spawnSync(process.execPath, buildMsgSendRelayArgs(workspace), { encoding: 'utf8', input: body });
    if (r.status !== 0) {
      process.stderr.write(`worker-exit-hook: 異常終了通知の投稿に失敗: ${(r.stderr || '').trim()}\n`);
    }
  }

  // 3. resumeへの応答確認・未返信時の代理送信
  if (isResumeInvocation && captureLogPath && sinceTimestamp && workerName && workspace) {
    try {
      // 契約のパース（第7引数。存在しなければ null → message-required 動作）
      let contract = null;
      if (contractSpecRaw) {
        try { contract = JSON.parse(contractSpecRaw); } catch {}
      }

      const parsedOffset = parseInt(logOffsetRaw, 10);
      verifyReplyAndRelayIfMissing({
        workspace, workerName, captureLogPath, sinceTimestamp,
        logOffset: Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0,
        contract,
      });
    } catch (error) {
      process.stderr.write(`worker-exit-hook: 返信確認・代理送信処理で例外: ${error.message}\n`);
    }
  }
}

module.exports = {
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhApiComments: (fn) => { _ghApiComments = fn; },
  _setGhPrList: (fn) => { _ghPrList = fn; },
  _setRelayMessage: (fn) => { _relayMessage = fn; },
  verifyReplyAndRelayIfMissing,
  checkPrCreatedDuringResume,
  buildMsgSendRelayArgs,
  MAX_RELAY_CHARS,
};
