#!/usr/bin/env node
// Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS] [--session-pid <pid>]
// Polls for review comments, commit pushes, and merge status. Emits:
//   REVIEW_COMMENT:<path>:<line>|<user>:<body>
//   PR_COMMENT:<user>:<body>
//   PR_REVIEW:<user>:<state>:<body>
//   PR_PUSH:<sha>
//   PR_MERGED:<PR>
//   PR_CLOSED:<PR>
//   POLL_ERROR:<detail>  (GitHubアクセスが失敗し始めたとき。遷移時のみ)
//   POLL_RECOVERED       (失敗から復旧したとき。遷移時のみ)
'use strict';

const { spawnSync } = require('./shared/child-process');
const fs = require('fs');
const path = require('path');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { notifyWatchdogExit } = require('./shared/watchdog-exit-notify');
const {
  extractTestDeclaration,
  evaluateTestDeclaration,
  findLatestTrustedTestDeclaration,
} = require('./shared/test-declaration');
const {
  resolveSessionPid,
  createDeadManSwitch,
  getProcessStartTime,
  registerProcess,
  cleanup: lifecycleCleanup,
} = require('./process-lifecycle');

const USAGE = `poll-reviews.js — PR のレビューコメント・push・マージ状態をポーリングする

Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS] [--session-pid <pid>] [--no-review-events]

Arguments:
  <PR>                対象の PR 番号
  [WORKSPACE]         状態ファイルを置くワークスペース（省略時は GH_MAESTRO_WORKSPACE env
                      またはCWDからの .gh-maestro/ 上方探索で解決）
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Options:
  --no-review-events   レビュー監視（inline/formalレビュー）を行わず、PR状態・テスト申告・push監視のみ行う
  --session-pid <pid>  監視対象のセッションPID（dead-man's switch用。省略時は自動検出）

Output (stdout):
  REVIEW_COMMENT:<path>:<line>|<user>:<body>  インラインレビューコメント
  PR_COMMENT:<user>:<body>                    PR 全体コメント
  PR_REVIEW:<user>:<state>:<body>             正式レビュー提出（APPROVED/CHANGES_REQUESTED/COMMENTED）
  PR_PUSH:<sha>                               新しいコミットが push された
  TEST_STATUS:<state>:<declaredSha>:<headSha>:<provenance>:<scope>:lint=<state>
                                              テスト申告状態・実行記録・lint状態
  PR_MERGED:<PR>                              マージ完了（このとき終了する）
  PR_CLOSED:<PR>                              却下・キャンセルでクローズ（このとき終了する）
  POLL_ERROR:<detail>                         GitHubアクセスが失敗し始めた（遷移時のみ。再試行は継続）
  POLL_RECOVERED                              失敗から復旧した（遷移時のみ）

PR_MERGED または PR_CLOSED を検出するまで永続的にポーリングする。
ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
消滅時はPID registryを解除して自動exitする。`;

/**
 * REST API が返す inline comment / formal review のIDは正の整数。gh のエラーレスポンス
 *（404 JSON 等）や切れた出力の断片が state に記録されたり中継されたりするのを防ぐため、
 * これらの経路では記録・中継の前に必ず検証する。
 * @param {string} id
 * @returns {boolean}
 */
function isValidCommentId(id) {
  return /^[0-9]+$/.test(id);
}

/**
 * `gh pr view --json comments` が返す PR 全体コメントのIDは、REST APIの数値IDではなく
 * GraphQLの不透明なグローバルノードID（例: `IC_kw...`）。commentsJsonはghのstatus確認と
 * JSON.parseを通過済みなので、ここでは空のIDだけを拒否する。REST由来の数値ID検証を
 * GraphQL由来のコメントへ流用しない。
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidPrCommentId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

/**
 * 新規の PR 全体コメントを中継イベントへ変換する純粋関数。
 * REST由来のコメント/レビューとはID空間が異なるため、専用の検証を使う。
 * @param {unknown} commentsList
 * @param {Set<string>} known
 * @returns {Array<{id: string, line: string}>}
 */
function buildPrCommentRelayEvents(commentsList, known) {
  if (!Array.isArray(commentsList)) return [];

  const events = [];
  for (const c of commentsList) {
    if (!c || typeof c !== 'object') continue;
    const id = c.id;
    if (!isValidPrCommentId(id) || known.has(id)) continue;
    const author = (c.author && c.author.login) || 'unknown';
    const singleLineBody = (c.body || '').replace(/\n/g, ' ');
    events.push({ id, line: `PR_COMMENT:${author}:${singleLineBody}` });
  }
  return events;
}

/**
 * ポーリングサイクルの結果から、劣化状態の遷移と発火すべきイベントを決める純粋関数。
 * 状態遷移（正常→劣化／劣化→復旧）のときだけイベントを返し、それ以外は null（スパム防止）。
 * @param {boolean} prevDegraded 直前の劣化状態
 * @param {boolean} hadError このサイクルで GitHub アクセスに失敗があったか
 * @returns {{ degraded: boolean, emit: 'POLL_ERROR' | 'POLL_RECOVERED' | null }}
 */
function pollDegradationTransition(prevDegraded, hadError) {
  if (hadError && !prevDegraded) return { degraded: true, emit: 'POLL_ERROR' };
  if (!hadError && prevDegraded) return { degraded: false, emit: 'POLL_RECOVERED' };
  return { degraded: prevDegraded, emit: null };
}

/**
 * PR状態から、監視終了を引き起こす終端イベントを決める純粋関数。
 * マージ（MERGED）と却下・キャンセル（CLOSED）の両方を終端として扱う
 * （Issue #289: 従来は MERGED のみ終端だったため、CLOSED された PR を監視し続けて
 * 機能死を起こした）。それ以外（OPEN 等）は null を返し監視を継続する。
 * @param {string} state PRのstate
 * @param {string} pr PR番号
 * @returns {string|null} 終端イベント行（PR_MERGED:<pr> / PR_CLOSED:<pr>）、非終端なら null
 */
function reviewTerminalEvent(state, pr) {
  if (state === 'MERGED') return `PR_MERGED:${pr}`;
  if (state === 'CLOSED') return `PR_CLOSED:${pr}`;
  return null;
}

/**
 * テスト申告の評価を、orchestrator が解釈できる固定形式の通知へ変換する。
 * provenance/scope を status と同じイベントに含め、v1/unknown と v2 full/partial/aggregate を
 * 通知だけでも区別できるようにする。lint状態も同じイベントへ含め、aggregate の層別事実は
 * query-test-status.js で照会する。lintの指摘・利用不能・欠落はテスト状態の停止条件ではないが、
 * 通知から状態を欠落させない。
 *
 * @param {{status?:string, declaredSha?:string, headSha?:string, provenance?:string, scope?:string, lint?:object, layers?:object, allLayersPresent?:boolean, allLayersComplete?:boolean}} evaluation
 * @returns {string}
 */
function formatTestStatusEvent(evaluation = {}) {
  const lint = evaluation.lint;
  let lintToken = 'missing';
  if (lint && lint.status === 'complete') {
    if (lint.outcome === 'findings') {
      const count = Number.isSafeInteger(lint.findingCount) ? lint.findingCount : 'unknown';
      lintToken = `complete/findings(${count})`;
    } else {
      lintToken = 'complete/pass';
    }
  } else if (lint && lint.status === 'unavailable') {
    const reason = typeof lint.reason === 'string' && lint.reason.trim()
      ? lint.reason.trim().replace(/[^A-Za-z0-9_-]/g, '_')
      : 'lint-result-unavailable';
    lintToken = `unavailable/${reason}`;
  }
  return [
    'TEST_STATUS',
    evaluation.status || 'NONE',
    evaluation.declaredSha || 'none',
    evaluation.headSha || 'none',
    evaluation.provenance || 'unknown',
    evaluation.scope || 'unknown',
    `lint=${lintToken}`,
  ].join(':');
}

/**
 * poll-reviews で使用する状態ファイルのパス定義。
 * ポーリングループと終了時クリーンアップとで定義が分散して残骸が残るのを防ぐため、ここに集約する。
 * @param {string} workspace
 * @param {string|number} pr
 * @returns {{ stateDir: string, stateFile: string, shaFile: string, testStatusFile: string, files: string[] }}
 */
function pollReviewsStateFiles(workspace, pr) {
  const stateDir = path.join(workspace, '.gh-maestro');
  const stateFile = path.join(stateDir, `poll-state-${pr}`);
  const shaFile = path.join(stateDir, `poll-sha-${pr}`);
  const testStatusFile = path.join(stateDir, `poll-test-status-${pr}`);
  return {
    stateDir,
    stateFile,
    shaFile,
    testStatusFile,
    files: [stateFile, shaFile, testStatusFile],
  };
}

/**
 * poll-reviews のポーリング実行ループ。
 *
 * @param {{pr:string|number,workspace:string,sessionPid?:string|number,intervalSec?:number,noReviewEvents?:boolean,maxCycles?:number}} params
 * @param {object} [deps]
 * @returns {Promise<{exitCode:number,reason?:string,terminalEvent?:string}>}
 */
async function runPollReviews(params, deps = {}) {
  const {
    pr,
    workspace,
    sessionPid,
    intervalSec = 30,
    noReviewEvents = false,
    maxCycles,
  } = params;

  const fsMod = deps.fs || fs;
  const writeStdoutFn = deps.writeStdoutFn || ((text) => process.stdout.write(text));
  const writeStderrFn = deps.writeStderrFn || ((text) => process.stderr.write(text));
  const sleepFn = deps.sleepFn || ((ms) => new Promise(r => setTimeout(r, ms)));
  const checkParentFn = deps.checkParentFn || (() => true);
  const cleanupFn = deps.cleanupFn || (() => {});

  const ghCapture = deps.ghCaptureFn || ((args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8' });
    if (r.status !== 0) {
      writeStderrFn(`poll-reviews: gh ${args.join(' ')} 失敗 (status ${r.status}): ${(r.stderr || '').toString().trim()}\n`);
      return null;
    }
    return r.stdout;
  });

  const repo = deps.repo || (ghCapture(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']) || '').trim();

  const {
    stateDir,
    stateFile,
    shaFile,
    testStatusFile,
  } = (deps.pollReviewsStateFilesFn || pollReviewsStateFiles)(workspace, pr);
  fsMod.mkdirSync(stateDir, { recursive: true });
  if (!fsMod.existsSync(stateFile)) fsMod.writeFileSync(stateFile, '');

  function knownIds() {
    return new Set(fsMod.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean));
  }

  function recordId(id) {
    fsMod.appendFileSync(stateFile, id + '\n');
  }

  const inlineJq = `.[] | [(.id | tostring), .path, ((.original_line // "?") | tostring), .user.login, (.body | gsub("\\n"; " "))] | join("|")`;
  const reviewsJq = `.[] | [(.id | tostring), .user.login, .state, (.body | gsub("\\n"; " "))] | join("|")`;

  let degraded = false;
  function noteCycleResult(hadError) {
    const t = pollDegradationTransition(degraded, hadError);
    degraded = t.degraded;
    if (t.emit === 'POLL_ERROR') {
      writeStdoutFn('POLL_ERROR:review監視のGitHubアクセスが失敗しています（一時的な可能性。復旧まで再試行を継続します）\n');
    } else if (t.emit === 'POLL_RECOVERED') {
      writeStdoutFn('POLL_RECOVERED\n');
    }
  }

  let cycle = 0;
  while (true) {
    if (typeof maxCycles === 'number' && cycle >= maxCycles) {
      return { exitCode: 0, reason: 'max_cycles_reached' };
    }
    cycle++;

    // dead-man's switch: 親セッション生存確認
    if (!checkParentFn()) {
      writeStderrFn(`poll-reviews: parent session (pid ${sessionPid}) is dead — exiting\n`);
      cleanupFn();
      return { exitCode: 0, reason: 'parent_dead' };
    }

    const prJson = ghCapture(['pr', 'view', String(pr), '--repo', repo,
      '--json', 'state,headRefOid,author', '-q', '[.state, .headRefOid, (.author.login // "")] | join("|")']);
    // PR状態が取れないサイクルは以降を丸ごとスキップ（誤った差分検知・中継を防ぐ）。
    if (prJson === null) {
      noteCycleResult(true);
      await sleepFn(intervalSec * 1000);
      continue;
    }
    const [state, headSha, prAuthor] = prJson.trim().split('|');

    // 終端イベント（MERGED / CLOSED）を検出したら監視を終了する。
    // CLOSED（却下・キャンセル）も終端として扱う（Issue #289: 従来は MERGED のみ終端だった
    // ため、CLOSED された PR を監視し続けて poll-pr.js が新 PR を検出できず機能死を起こした）。
    const terminalEvent = reviewTerminalEvent(state, String(pr));
    if (terminalEvent) {
      writeStdoutFn(`${terminalEvent}\n`);
      cleanupFn();
      return { exitCode: 0, terminalEvent };
    }

    let isPushEvent = false;
    const prevSha = fsMod.existsSync(shaFile) ? fsMod.readFileSync(shaFile, 'utf8').trim() : '';
    if (headSha && headSha !== prevSha) {
      fsMod.writeFileSync(shaFile, headSha);
      if (prevSha) {
        writeStdoutFn(`PR_PUSH:${headSha}\n`);
        isPushEvent = true;
      }
    }

    const known = knownIds();
    let hadError = false;

    if (!noReviewEvents) {
      const inlineOut = ghCapture(['api', `repos/${repo}/pulls/${pr}/comments`,
        '--paginate', '-q', inlineJq]);
      if (inlineOut !== null) {
        for (const line of inlineOut.split('\n').filter(Boolean)) {
          const sep = line.indexOf('|');
          const id = line.slice(0, sep);
          if (!isValidCommentId(id) || known.has(id)) continue;
          recordId(id);
          writeStdoutFn(`REVIEW_COMMENT:${line.slice(sep + 1)}\n`);
        }
      } else {
        hadError = true;
      }
    }

    // PR コメント（テスト結果申告マーカーの抽出・判定もここで行う）
    const commentsJson = ghCapture(['pr', 'view', String(pr), '--repo', repo,
      '--json', 'comments']);
    if (commentsJson !== null) {
      let commentsList = [];
      try {
        const parsed = JSON.parse(commentsJson);
        commentsList = parsed.comments || [];
      } catch {}

      // 第三者による偽の申告捏造（Issue #209）を防ぐため、PR作成者または権限保持者の
      // 最新の有効なコメントだけを共有ヘルパー経由で採用する。
      const latestDecl = findLatestTrustedTestDeclaration(commentsList, prAuthor);
      const testEvaluation = evaluateTestDeclaration(latestDecl, headSha);
      const evalKey = [
        testEvaluation.status,
        testEvaluation.declaredSha || '',
        testEvaluation.headSha || '',
        testEvaluation.provenance || 'unknown',
        testEvaluation.scope || 'unknown',
        testEvaluation.fail === undefined ? '' : testEvaluation.fail,
        testEvaluation.pass === undefined ? '' : testEvaluation.pass,
        formatTestStatusEvent(testEvaluation).split(':').at(-1),
      ].join(':');
      const prevEvalKey = fsMod.existsSync(testStatusFile) ? fsMod.readFileSync(testStatusFile, 'utf8').trim() : '';

      if (evalKey !== prevEvalKey || isPushEvent) {
        fsMod.writeFileSync(testStatusFile, evalKey);
        writeStdoutFn(formatTestStatusEvent(testEvaluation) + '\n');
      }

      for (const event of buildPrCommentRelayEvents(commentsList, known)) {
        recordId(event.id);
        writeStdoutFn(`${event.line}\n`);
      }
    } else {
      hadError = true;
    }

    if (!noReviewEvents) {
      const reviewsOut = ghCapture(['api', `repos/${repo}/pulls/${pr}/reviews`,
        '--paginate', '-q', reviewsJq]);
      if (reviewsOut !== null) {
        for (const line of reviewsOut.split('\n').filter(Boolean)) {
          const sep = line.indexOf('|');
          const id = line.slice(0, sep);
          if (!isValidCommentId(id) || known.has(id)) continue;
          recordId(id);
          const rest = line.slice(sep + 1); // user|state|body
          const [user, reviewState, ...bodyParts] = rest.split('|');
          const body = bodyParts.join('|');
          // APPROVED/CHANGES_REQUESTED は body が空でも emit（マージ判断に必要）
          if (body.trim() || reviewState === 'APPROVED' || reviewState === 'CHANGES_REQUESTED') {
            writeStdoutFn(`PR_REVIEW:${user}:${reviewState}:${body}\n`);
          }
        }
      } else {
        hadError = true;
      }
    }

    noteCycleResult(hadError);
    await sleepFn(intervalSec * 1000);
  }
}

/**
 * poll-reviews の CLI メイン関数。
 * process.exit() は直接呼ばず、結果オブジェクト（exitCode 等）を返す。
 * require.main === module の薄いエントリポイントから呼び出される。
 *
 * @param {string[]} [argv]
 * @param {object} [deps]
 * @returns {Promise<{exitCode:number}>}
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  const parseFlagsFn = deps.parseFlagsFn || parseFlags;
  const resolveWorkspaceFn = deps.resolveWorkspaceFn || resolveWorkspace;
  const pollReviewsStateFilesFn = deps.pollReviewsStateFilesFn || pollReviewsStateFiles;
  const resolveSessionPidFn = deps.resolveSessionPidFn || resolveSessionPid;
  const getProcessStartTimeFn = deps.getProcessStartTimeFn || getProcessStartTime;
  const createDeadManSwitchFn = deps.createDeadManSwitchFn || createDeadManSwitch;
  const registerProcessFn = deps.registerProcessFn || registerProcess;
  const lifecycleCleanupFn = deps.lifecycleCleanupFn || lifecycleCleanup;
  const notifyWatchdogExitFn = deps.notifyWatchdogExitFn || notifyWatchdogExit;
  const runPollReviewsFn = deps.runPollReviewsFn || runPollReviews;
  const logFn = deps.logFn || console.log;
  const errorFn = deps.errorFn || console.error;
  const fsMod = deps.fs || fs;

  let values, rest;
  try {
    ({ values, rest } = parseFlagsFn(argv, {
      flags: { '--session-pid': {} },
      booleans: ['--help', '-h', '--no-review-events'],
      // pr（必須）・workspace・interval の3つまで。未知フラグ・余剰位置引数はパーサ側で拒否。
      positionals: { min: 1, max: 3 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      logFn(USAGE);
      return { exitCode: 0 };
    }
    for (const e of err.errors) errorFn(`poll-reviews: ${e.message}`);
    errorFn(USAGE);
    return { exitCode: 1 };
  }

  if (values['--help'] || values['-h']) {
    logFn(USAGE);
    return { exitCode: 0 };
  }

  const noReviewEvents = Boolean(values['--no-review-events']);
  const sessionPidArg = values['--session-pid'];
  const [pr, workspaceArg, intervalArg] = rest;
  const intervalSec = parseInt(intervalArg || '30');

  if (!pr) {
    errorFn(USAGE);
    return { exitCode: 1 };
  }

  // 他スクリプト（poll-pr.js等）と同じ workspace 解決順（引数 >
  // GH_MAESTRO_WORKSPACE env > CWD探索）に統一する。素の process.cwd() フォールバックだと、CWD が
  // ホームディレクトリ配下のどこか等に誤解決される余地が残るため使わない
  // （Issue #214: process-lifecycle.js の PID registry が managed root と衝突する事故の一因）。
  const workspace = resolveWorkspaceFn(workspaceArg);
  if (!workspace) {
    errorFn('poll-reviews: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    return { exitCode: 1 };
  }

  const stateFiles = pollReviewsStateFilesFn(workspace, pr);

  // ── ライフサイクル管理 ─────────────────────────────────────────────────

  const sessionPid = resolveSessionPidFn(sessionPidArg);

  // PID再利用検知のため、起動時に親セッションの起動時刻を捕捉する（best-effort。
  // 取得失敗時は expectedStartTime=null となり isProcessAlive のみの従来判定にフォールバック）。
  const expectedStartTime = getProcessStartTimeFn(sessionPid);
  const checkParent = createDeadManSwitchFn(sessionPid, { expectedStartTime });

  // PID registry に自己登録
  registerProcessFn(workspace, { script: 'poll-reviews.js' });

  function cleanup() {
    lifecycleCleanupFn(workspace, () => {
      for (const file of stateFiles.files) {
        try { fsMod.unlinkSync(file); } catch {}
      }
    });
  }

  if (deps.registerSignalHandlers !== false) {
    process.on('SIGINT',  () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    // 異常終了（非ゼロexit）を orchestrator へ通知する（Issue #289 受け入れ条件3）。
    // 正常終了（exit 0: SIGINT/SIGTERM/親セッション消滅/MERGED/CLOSED）では何もしない。
    // process.on('exit') は同期コードしか実行できないため、共有ヘルパーは spawnSync で
    // 同期投稿する（best-effort・throwしない）。
    process.on('exit', () => { notifyWatchdogExitFn({ workspace, scriptName: 'poll-reviews.js' }); });
  }

  try {
    const result = await runPollReviewsFn({
      pr,
      workspace,
      sessionPid,
      intervalSec,
      noReviewEvents,
    }, {
      checkParentFn: checkParent,
      cleanupFn: cleanup,
      ...deps.runPollReviewsDeps,
    });
    return result;
  } catch (err) {
    errorFn('poll-reviews fatal:', err);
    cleanup();
    return { exitCode: 1 };
  }
}

module.exports = {
  main,
  isValidCommentId,
  isValidPrCommentId,
  buildPrCommentRelayEvents,
  extractTestDeclaration,
  evaluateTestDeclaration,
  pollDegradationTransition,
  reviewTerminalEvent,
  formatTestStatusEvent,
  pollReviewsStateFiles,
  runPollReviews,
};

if (require.main === module) {
  main().then((result) => {
    process.exit(result.exitCode);
  }).catch((err) => {
    console.error('poll-reviews fatal:', err);
    process.exit(1);
  });
}
