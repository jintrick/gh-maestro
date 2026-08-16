#!/usr/bin/env node
// msg-send.js — GitHub Issue コメントを経由してメッセージを送信する
//
// Usage:
//   node msg-send.js <recipient> [--from <name>] [--issue <N>] [--workspace <path>] (--body-file <path> | --stdin)
//
// workspace resolution order:
//   GH_MAESTRO_WORKSPACE env > --workspace arg > CWD upward search
//
// from resolution order:
//   --from arg > GH_MAESTRO_WORKER env > 'orchestrator'
//
// 本文は位置引数では渡せない（--body-file / --stdin のいずれか必須）。生成された
// 自由文をbashの位置引数へインライン展開すると、本文中のバッククォート/`$`が
// コマンド置換として解釈され内容が黙って消える事故（不可逆かつ事後検出不可能）が
// 起きるため、本文はシェルの引数展開を経由しない経路だけをサポートする。

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { toWinPath } = require('./win-path');
const { resolveTextInput, StdinTTYError } = require('./shared/text-input');
const { markCommentResult, readRegistry } = require('./shared/execution-registry');
const { isRetryableGhFailure, graphqlAddComment } = require('./shared/gh-fallback');
const { ensureInboxSupervisorRunning } = require('./shared/ensure-inbox-supervisor');
const { ensureMsgPollOrchestratorRunning } = require('./shared/ensure-msg-poll-orchestrator');
const { resolveWorkerName, readWorkersRaw } = require('./shared/workers-registry');
const { normalizeWorkerEntry } = require('./worker-entry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const { hasReportedSinceStart } = require('./shared/worker-report-check');
const { main: writeDraftMain } = require('./write-draft');

const USAGE = `msg-send.js — GitHub Issue コメント経由でメッセージを送信する

Usage (ワーカーから orchestrator へ報告):
  node msg-send.js --stdin <<'EOF'
  <本文>
  EOF
Usage (orchestrator からワーカーへ送信):
  node msg-send.js --issue <N> --skill <role> [--workspace <path>] --stdin <<'EOF'
  <本文>
  EOF
  node msg-send.js <recipient> --body-file <path> [--from <name>] [--issue <N>] [--workspace <path>] [--raw] [--execution-id <id>]

Arguments:
  <recipient>           送信先（worker 名、または "orchestrator"）。--skill 使用時は指定しない。
                        ワーカーコンテキスト（GH_MAESTRO_WORKER 有り）では常に orchestrator 宛に固定され、
                        recipient を書く必要はない。

Options:
  --skill <role>        （orchestrator 専用）送信先ワーカーを〈--issue + 役割（gh-maestro-coder等）〉で指定する。
                        workers.json から一意に解決する。ワーカーコンテキストでは使用不可（エラー）。
                        該当が複数ある場合は候補を表示してエラー終了するので --worker 名（位置引数）で明示する。
  --from <name>         送信元名。ワーカーコンテキストでは無視され、常に GH_MAESTRO_WORKER の値になる。
  --issue <N>           投稿先の Issue 番号。--skill 使用時は必須。ワーカーコンテキストでは
                        ワーカー名 issue-<N>-<desc> から自動導出されるため通常は不要。
  --workspace <path>    ワークスペースパス（省略時は環境変数またはCWDから解決）
  --body-file <path>    メッセージ本文を記載したファイルのパス（UTF-8）。
  --stdin               標準入力から本文を読み込む。ヒアドキュメントの終端記号は必ずクォート付き
                        （<<'EOF'）にすること。クォート無しだと本文中のドル記号/バッククォートが
                        ヒアドキュメント内でも展開されてしまい、位置引数と同じ事故が再現する。
  --raw                 メッセージ用のマーカー・引用ヘッダーを付けず、本文をそのまま Issue コメントに投稿する。
  --execution-id <id>  実行記録と紐付けるID。投稿成功時だけ completed として記録する。

本文は --body-file と --stdin のどちらか一方を必ず指定する（同時指定・両方省略はエラー）。
本文を位置引数で渡すことはできない（渡すとエラーになる）。

Output (stdout):
  投稿されたコメントの URL を1行出力

コンテキスト判定: GH_MAESTRO_WORKER 環境変数の有無でワーカー/orchestrator を判別する
  （spawn-worker.js / inbox-supervisor.js が起動時にワーカーへ注入する）。
workspace 解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索

拒否ガード（orchestrator からワーカー宛ての送信のみ）: 宛先ワーカーが稼働中（作業中）で、
  直近の起動以降まだ orchestrator へ報告していないと確定的に判定できた場合、GitHub には
  一切投稿せず、その場で送信を拒否し code 1 で理由を返す。送ろうとした本文は /tmp 配下へ
  退避され、そのパスが拒否メッセージに含まれる。判定に必要な事実（起動時刻・GitHub APIの
  応答）を確認できない場合は拒否せず通す（フェイルオープン。通常どおり休止待ちキューへ積む）。
  既に報告済みのまま稼働中（居座り）の場合も拒否しない（inbox-supervisor が異常として通知する）。`;

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', ...opts });
};

// テスト実行中（node --test）の実投稿を構造的に防ぐガード。
// node --test は NODE_TEST_CONTEXT をテストファイルへ自動設定し、そこから spawn された
// 子プロセスにも継承される。実障害: worker-exit-hook.js の実spawnテストがワーカー文脈の
// 環境変数を子へ継承し、この msg-send.js が実ワークスペース・実Issueへ偽の異常終了通知を
// 投稿した（Issue #202）。テスト側の envクリーン漏れに依存しない多層防御として、
// msg-send.js 本体が本物の投稿を機械的にブロックする
// （Issue #151 で launchAgentHeadless に入れた NODE_TEST_CONTEXT ガードと同じ検出方式）。
function testContextPostBlockReason() {
  if (process.env.NODE_TEST_CONTEXT) {
    return 'テスト実行中（NODE_TEST_CONTEXT）のため、実際のGitHub投稿は行いません';
  }
  return null;
}

// 実装の既定値。_resetGhIssueComment で復元可能にするため名前付き const で保持する。
const defaultGhIssueComment = (issue, body, repo, opts = {}) => {
  const blockReason = testContextPostBlockReason();
  if (blockReason) {
    // gh を一切呼ばずに拒否する（フェイルクローズ）。main() が stderr として報告する。
    return { status: 1, stdout: '', stderr: `投稿を拒否しました: ${blockReason}` };
  }

  const restResult = spawnSync('gh', ['issue', 'comment', String(issue), '--body-file', '-'], {
    input: body, encoding: 'utf8', ...opts,
  });

  if (restResult.status === 0 || !isRetryableGhFailure(restResult)) {
    return restResult;
  }

  process.stderr.write('msg-send: REST API失敗のためGraphQLにフォールバックします\n');
  return graphqlAddComment({ repo, issue, body, opts });
};

let _ghIssueComment = defaultGhIssueComment;

// テストで注入可能（実gh呼び出しを避けるため）。既定は shared/gh-comments.js の実装。
let _ghListComments = (repo, issue, opts = {}) => listComments(repo, issue, opts);

/**
 * 送信しようとした本文を /tmp 配下の一時ファイルへ退避する。
 *
 * 拒否時に本文をその場で失わせると、送り手（orchestrator＝LLM）は書き直しを強いられ、
 * 内容が劣化するか面倒がって省略される。write-draft.js と同じ経路（win-path解決＋
 * 許可ルート(/tmp)封じ込め）で保存し、実体パスを拒否メッセージに含める。
 *
 * @param {string} workerName
 * @param {string} body
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function saveRejectedBody(workerName, body) {
  const logicalPath = `/tmp/msg-send-rejected-${workerName}-${Date.now()}.md`;
  let result;
  try {
    result = writeDraftMain([logicalPath, '--stdin'], { readStdinFn: () => body, isStdinTTY: () => false });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (result.code !== 0) return { ok: false, error: result.stderr || '(unknown error)' };
  const m = /^DRAFT_WRITTEN:(.+)$/m.exec(result.stdout || '');
  if (!m) return { ok: false, error: '書き込み結果から実体パスを取得できませんでした' };
  return { ok: true, path: m[1] };
}

/**
 * 拒否メッセージを組み立てる。
 *
 * 読み手は orchestrator（LLM）であり、この文面だけが次の行動を決める唯一の指導文になる。
 * 「送るな」とだけ言うと、賢いモデルほど迂回路（gh issue comment での直接投稿、ワーカーを
 * 終了させて休止状態にしてから送る）を自力で見つけてしまうため、両方を名指しで禁止する。
 * 「後で送り直せ」ではなく「報告を受けてから統合して一度に送れ」と書くのは、単なる
 * 再送指示だと本Issueが解決しようとしている「指示の分断」がそのまま再発するため。
 */
function buildBusyRejectionMessage({ workerName, entry, issue, draftPath }) {
  const draftLine = draftPath
    ? `送ろうとした本文は ${draftPath} に退避しました。`
    : '送ろうとした本文の退避に失敗しました。内容を控えてから、報告受領後に送り直してください。';
  return [
    `ワーカー "${workerName}"（pid ${entry.pid}）は作業中で、まだ報告を出していません。この指示は送信していません（GitHubにも残していません）。`,
    draftLine,
    `このワーカーの報告は Issue #${issue} のコメントとして届きます。報告を受け取ってから、その内容と退避した本文を統合して一度に送ってください。`,
    '次のことはしないでください: gh issue comment でマーカー付きコメントを直接投稿する / ワーカーを終了させてから送る。どちらも指示の分断とセッションの破壊を招きます。',
  ].join('\n');
}

/**
 * 作業中（生存中）で、直近の起動以降にまだ orchestrator へ報告していないワーカー宛ての
 * 送信を、投稿前に拒否する（Issue #263）。
 *
 * 「作業中に思いついた追伸」を無条件にキューへ積むと、送り手はそれが届いていないことに
 * 気づけない。相手が休止中（isWorkerAlive===false）なら通常どおり配送経路（resume）に
 * 任せるためここでは何もしない。相手が生存中でも、既に報告済みなら「居座り」であり
 * 送り手の誤りではないため拒否しない（inbox-supervisor が異常として通知する）。
 *
 * 判定に必要な事実（起動時刻・報告コメントの有無）を確認できない場合は拒否せず通す
 * （フェイルオープン）。ここで通しても起きるのは「メッセージが休止待ちキューへ積まれ、
 * 相手が休止した時点で配送される」という従来どおりの動作であり損害はない。逆に拒否すると
 * GitHubが一時的に不調な間はワーカーへ一切指示を送れなくなり、起動時刻を記録できなかった
 * エントリには恒久的に送信不能になる——主要ワークフローが止まる方が損害が大きい。
 * `.claude/rules/fail-closed-safety-guards.md` は「通すと損害が出るガード」に適用するもので
 * あり、本件はその前提を満たさない。「報告が届かないまま誰も気づけない」という本Issueの
 * 核心は、この送信ガードではなく inbox-supervisor 側の居座り通知（STALE_REPORT_DETECTED）
 * が担う。
 *
 * @param {object} params
 * @param {string} params.workspace
 * @param {string} params.workerName  - 送信先ワーカー名
 * @param {string} params.repo
 * @param {string} params.issue
 * @param {object} params.ghOpts
 * @param {string} params.body        - 送信しようとしていた本文（拒否時に退避する）
 * @returns {string|null}  拒否メッセージ（拒否する場合）。拒否しない場合は null。
 */
function checkWorkerBusyRejection({ workspace, workerName, repo, issue, ghOpts, body }) {
  // readWorkersRaw は不在のみ null、破損は throw する。このガードは上記 docstring のとおり
  // 「判定不能は拒否せず通す（フェイルオープン）」契約のため、破損も null に落として通す。
  // 判定不能時にここで通しても損害はない（従来どおり休止待ちキューへ積まれて配送される）。
  let raw;
  try { raw = readWorkersRaw(workspace); } catch { return null; }
  if (!raw || !(workerName in raw)) return null; // 未登録の宛先はこのガードの対象外（issue解決等が別途扱う）

  const entry = normalizeWorkerEntry(raw[workerName]);
  if (!isWorkerAlive(entry)) return null; // 休止中 → 通常どおり配送に任せる

  if (!entry.startTime) return null; // 判定不能（起動時刻不明）→ 通す

  const commentsResult = _ghListComments(repo, issue, ghOpts);
  if (commentsResult.status !== 0) return null; // 判定不能（GitHub API取得失敗）→ 通す

  let comments;
  try {
    comments = parseCommentsResponse(commentsResult.stdout);
  } catch {
    comments = null;
  }
  if (!comments) return null; // 判定不能（応答解釈失敗）→ 通す

  const reported = hasReportedSinceStart(comments, workerName, entry.startTime);
  if (reported !== false) return null; // true(居座り) / null(判定不能) は拒否しない

  const draft = saveRejectedBody(workerName, body);
  return buildBusyRejectionMessage({ workerName, entry, issue, draftPath: draft.ok ? draft.path : null });
}

// ── メインロジック ──────────────────────────────────────────────────────

/**
 * @param {string[]} [argsOverride]  省略時は process.argv.slice(2)
 * @param {object}   [envOverride]   省略時は process.env
 * @param {{ readStdinFn?: () => string, isStdinTTY?: () => boolean }} [ioOverride]  --stdin用の注入（テスト用）
 * @returns {{ code: number, lines: string[], errLines: string[] }}
 */
function main(argsOverride, envOverride, ioOverride) {
  const out = [];
  const err = [];

  const writeOut = (s) => out.push(s);
  const writeErr = (s) => err.push(s);

  const args = argsOverride || process.argv.slice(2);
  const env = envOverride || process.env;
  const { readStdinFn, isStdinTTY } = ioOverride || {};

  const rawIndex = args.indexOf('--raw');
  const raw = rawIndex !== -1;
  // --raw はマーカー無し投稿モードのため、パーサには渡さず手動で除去する（移行時も温存）。
  const parsedArgs = raw ? args.filter((_, index) => index !== rawIndex) : args;
  let values, rest;
  try {
    ({ values, rest } = parseFlags(parsedArgs, {
      flags: { '--workspace': {}, '--issue': {}, '--from': {}, '--body-file': {}, '--execution-id': {}, '--skill': {} },
      booleans: ['--stdin', '--help', '-h'],
      // 宛先（recipient）は位置引数で受け取る。個数の妥当性は下の extraPositionals 判定で
      // 専用メッセージ（--stdin / --body-file 案内）と共に検証するため、パーサ側では上限を設けない。
      positionals: { min: 0, max: Infinity },
    }));
  } catch (e) {
    if (e.name !== 'ArgsValidationError') throw e;
    if (e.helpRequested) {
      writeOut(USAGE);
      return { code: 0, lines: out, errLines: err };
    }
    for (const ve of e.errors) writeErr(`msg-send: ${ve.message}`);
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (values['--help'] || values['-h']) {
    writeOut(USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('msg-send: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { code: 1, lines: out, errLines: err };
  }

  // ── コンテキスト判定 ────────────────────────────────────────────────────
  // GH_MAESTRO_WORKER が環境にあれば「ワーカーとして実行中」。ワーカーは常に orchestrator へ
  // 自分の名を from として報告するだけであり、orchestrator 専用の宛先解決機構（--skill）は
  // 使えない。この判定で成りすまし（from が silent に orchestrator へ化ける）と誤配送
  // （自分自身や他ワーカーを宛先にする）を構造的に不可能にする。
  const workerIdentity = env.GH_MAESTRO_WORKER || null;
  const isWorker = !!workerIdentity;

  // ── 送信先の解決 ────────────────────────────────────────────────────────
  // recipient（宛先）の位置引数解釈は本文入力方式の変更と無関係に維持する。
  // extraPositionals（宛先解釈後に余った位置引数）はもはや本文として使わない —
  // 1つでも残っていれば「本文を位置引数で渡そうとした」誤用として下で一律拒否する。
  const skillFlag = values['--skill'];
  let recipient;
  let extraPositionals;

  if (isWorker) {
    if (skillFlag) {
      writeErr('msg-send: --skill は orchestrator 専用です。ワーカーからの報告は宛先を指定せず本文だけで送ってください（例: node msg-send.js --stdin <<\'EOF\' ... EOF）。');
      writeErr(USAGE);
      return { code: 1, lines: out, errLines: err };
    }
    if (raw) {
      // --raw（マーカー無しでIssueへ直接投稿。architectの設計コメント等）は宛先をマーカーに
      // 使わないため、位置引数の扱いは従来通り（先頭を宛先プレースホルダ）に保つ。
      recipient = rest[0] || workerIdentity;
      extraPositionals = rest.length > 0 ? rest.slice(1) : rest;
    } else {
      // マーカー付き報告は常に orchestrator 宛。旧テンプレの先頭 'orchestrator' は冗長なので剥がす。
      recipient = 'orchestrator';
      extraPositionals = (rest[0] === 'orchestrator') ? rest.slice(1) : rest;
    }
  } else if (skillFlag) {
    // （orchestrator が）--skill 指定時は〈--issue + 役割〉から workerName を逆引きする。
    // --skill モードでは位置引数に recipient を置かない。
    const skillIssue = values['--issue'] || env.ISSUE || null;
    if (!skillIssue) {
      writeErr('msg-send: --skill 使用時は --issue が必要です（送信先ワーカーを issue+役割で特定するため）。');
      return { code: 1, lines: out, errLines: err };
    }
    try {
      recipient = resolveWorkerName(workspace, { issue: skillIssue, skill: skillFlag });
    } catch (e) {
      writeErr(`msg-send: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }
    extraPositionals = rest;
  } else {
    recipient = rest[0];
    extraPositionals = rest.slice(1);
  }

  if (extraPositionals.length > 0) {
    writeErr('msg-send: 本文は位置引数で渡せません。--body-file <path> または --stdin を使ってください（詳細は --help）。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  // ── 本文解決: --body-file と --stdin のどちらか一方が必須 ─────────────────
  // 生成された自由文をbashの位置引数へインライン展開すると、本文中のバッククォート/`$`が
  // コマンド置換として解釈され内容が黙って消える（しかもNodeがargvを受け取る前に消えるため
  // 事後検出は原理的に不可能）。この事故を構造的に防ぐため、本文は必ずシェルの引数展開を
  // 経由しない経路（ファイル読み込み／標準入力）だけで受け取る。
  const bodyFileArg = values['--body-file'];
  const useStdin = values['--stdin'] === true;

  if (!bodyFileArg && !useStdin) {
    writeErr('msg-send: 本文は --body-file <path> または --stdin で渡してください。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }
  if (bodyFileArg && useStdin) {
    writeErr('msg-send: --body-file と --stdin は同時に指定できません。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  let body;
  try {
    body = resolveTextInput({
      filePath: bodyFileArg ? toWinPath(bodyFileArg) : null,
      stdin: useStdin,
      readStdinFn,
      isStdinTTY,
    });
  } catch (e) {
    if (e instanceof StdinTTYError) {
      writeErr(`msg-send: --stdin が指定されましたが${e.message}`);
    } else {
      writeErr(`msg-send: --body-file の読み込みに失敗しました: ${e.message}`);
    }
    return { code: 1, lines: out, errLines: err };
  }

  if (!recipient) {
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (!body) {
    writeErr('msg-send: メッセージ本文が必要です。');
    writeErr(USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  // ── from の解決 ────────────────────────────────────────────────────────
  // ワーカーコンテキストでは常に自分の識別名（--from の誤指定・省略に関わらず）。
  // これにより「--from 省略時に silent に orchestrator へ化ける」成りすましを構造的に排除する。
  const from = isWorker ? workerIdentity : (values['--from'] || 'orchestrator');

  // ── issue の解決 ────────────────────────────────────────────────────────
  // 優先順: --issue > env ISSUE > ワーカー名から導出 > workers.json（worker 宛のみ）
  // orchestrator 宛で解決できなければ exit 1（フェイルクローズ）

  let issue = values['--issue'] || env.ISSUE || null;

  // ワーカーコンテキストでは、ワーカー名 issue-<N>-<desc> から Issue番号を導出できる。
  // これによりワーカーの報告は本文だけ（node msg-send.js --stdin <<'EOF' ... EOF）で完結する。
  if (!issue && isWorker) {
    const m = /^issue-(\d+)-/.exec(workerIdentity);
    if (m) issue = m[1];
  }

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

  // ── 作業中で未報告のワーカーへの送信を拒否する（Issue #263） ────────────────
  // orchestrator コンテキスト（!isWorker）から「ワーカー」宛て（recipient !== 'orchestrator'）
  // の送信にのみ適用する。ワーカー→orchestrator の報告（isWorker時は recipient が常に
  // 'orchestrator' に固定される）、inbox-supervisor からの通知（recipient='orchestrator'
  // 固定）はこの条件に入らず影響を受けない。
  if (!isWorker && recipient !== 'orchestrator') {
    const rejectionMessage = checkWorkerBusyRejection({ workspace, workerName: recipient, repo, issue, ghOpts, body });
    if (rejectionMessage) {
      writeErr('msg-send: 送信を拒否しました。');
      for (const line of rejectionMessage.split('\n')) writeErr(line);
      return { code: 1, lines: out, errLines: err };
    }
  }

  // ── マーカー生成 ────────────────────────────────────────────────────────

  const marker = JSON.stringify({ v: 1, to: recipient, from });
  const directionIcon = from === 'orchestrator' ? '📤' : '📥';
  const humanHeader = `> ${directionIcon} **From:** \`${from}\` ➔ **To:** \`${recipient}\`\n>\n> ` + body.replace(/\n/g, '\n> ');
  const fullBody = raw ? body : `<!-- gh-maestro ${marker} -->\n${humanHeader}`;
  const executionId = values['--execution-id'];
  if (executionId) {
    try {
      const execution = readRegistry(workspace)[executionId];
      if (execution?.status === 'completed') {
        writeOut(execution.commentUrl);
        return { code: 0, lines: out, errLines: err };
      }
    } catch (e) {
      writeErr(`msg-send: 実行記録を読み込めません: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }
  }

  // ── 送信 ────────────────────────────────────────────────────────────────

  const result = _ghIssueComment(issue, fullBody, repo, ghOpts);

  if (result.status !== 0) {
    if (executionId) {
      try { markCommentResult(workspace, executionId, { error: result.stderr || '(empty)' }); } catch (_) {}
    }
    writeErr(`msg-send: コメント投稿に失敗しました: ${result.stderr || '(empty)'}`);
    return { code: 1, lines: out, errLines: err };
  }

  const commentUrl = result.stdout.trim();
  if (!commentUrl) {
    if (executionId) {
      try { markCommentResult(workspace, executionId, { error: 'URLが取得できませんでした' }); } catch (_) {}
    }
    writeErr('msg-send: コメント投稿は成功しましたがURLが取得できませんでした。');
    return { code: 1, lines: out, errLines: err };
  }

  if (executionId) {
    try {
      markCommentResult(workspace, executionId, { commentUrl });
    } catch (e) {
      writeErr(`msg-send: コメント投稿は成功しましたが実行記録を更新できませんでした: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }
  }

  // --- inbox-supervisor.js / msg-poll.js(orchestrator) の自動起動保証（best-effort） ---
  // ワーカー宛て送信時のみ。orchestratorが手動起動を忘れても配送経路が失われないようにする
  // （ensure-inbox-supervisor.js / ensure-msg-poll-orchestrator.js 参照）。稼働中なら二重起動には
  // ならない。msg-poll.js はオーケストレーターセッションの inbox 監視（Issue #301）。
  if (recipient !== 'orchestrator') {
    try { ensureInboxSupervisorRunning({ workspace, scriptsPath: __dirname }); } catch {}
    try {
      const pollResult = ensureMsgPollOrchestratorRunning({ workspace, scriptsPath: __dirname });
      if (pollResult && pollResult.spawned) {
        writeErr('msg-send: [警告] orchestratorのinbox監視(msg-poll.js)が未起動だったため保険機構により自動起動しました。このプロセスの通知はセッションに届きません。SKILL.mdに従いMonitorでinbox監視を起動してください。');
      }
    } catch {}
  }

  writeOut(commentUrl);
  return { code: 0, lines: out, errLines: err };
}

// ── テスト用 export ──────────────────────────────────────────────────────

module.exports = {
  _setGhRepoView: (fn) => { _ghRepoView = fn; },
  _setGhIssueComment: (fn) => { _ghIssueComment = fn; },
  _resetGhIssueComment: () => { _ghIssueComment = defaultGhIssueComment; },
  _setGhListComments: (fn) => { _ghListComments = fn; },
  testContextPostBlockReason,
  checkWorkerBusyRejection,
  main,
  USAGE,
};

if (require.main === module) {
  const { code, lines, errLines } = main();
  for (const l of errLines) process.stderr.write(l + '\n');
  for (const l of lines) process.stdout.write(l + '\n');
  process.exit(code);
}
