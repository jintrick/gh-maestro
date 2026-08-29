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

Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS] [--session-pid <pid>]

Arguments:
  <PR>                対象の PR 番号
  [WORKSPACE]         状態ファイルを置くワークスペース（省略時は GH_MAESTRO_WORKSPACE env
                      またはCWDからの .gh-maestro/ 上方探索で解決）
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Options:
  --session-pid <pid>  監視対象のセッションPID（dead-man's switch用。省略時は自動検出）

Output (stdout):
  REVIEW_COMMENT:<path>:<line>|<user>:<body>  インラインレビューコメント
  PR_COMMENT:<user>:<body>                    PR 全体コメント
  PR_REVIEW:<user>:<state>:<body>             正式レビュー提出（APPROVED/CHANGES_REQUESTED/COMMENTED）
  PR_PUSH:<sha>                               新しいコミットが push された
  TEST_STATUS:<state>:<declaredSha>:<headSha>:<provenance>:<scope>
                                              テスト申告状態と実行記録
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
 * provenance/scope を status と同じイベントに含め、v1/unknown と v2 full/partial を
 * 通知だけでも区別できるようにする。
 *
 * @param {{status?:string, declaredSha?:string, headSha?:string, provenance?:string, scope?:string}} evaluation
 * @returns {string}
 */
function formatTestStatusEvent(evaluation = {}) {
  return [
    'TEST_STATUS',
    evaluation.status || 'NONE',
    evaluation.declaredSha || 'none',
    evaluation.headSha || 'none',
    evaluation.provenance || 'unknown',
    evaluation.scope || 'unknown',
  ].join(':');
}

module.exports = {
  isValidCommentId,
  isValidPrCommentId,
  buildPrCommentRelayEvents,
  extractTestDeclaration,
  evaluateTestDeclaration,
  pollDegradationTransition,
  reviewTerminalEvent,
  formatTestStatusEvent,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--session-pid': {} },
      booleans: ['--help', '-h'],
      // pr（必須）・workspace・interval の3つまで。未知フラグ・余剰位置引数はパーサ側で拒否。
      positionals: { min: 1, max: 3 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      process.exit(0);
    }
    for (const e of err.errors) console.error(`poll-reviews: ${e.message}`);
    console.error(USAGE);
    process.exit(1);
  }

  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    process.exit(0);
  }

  const sessionPidArg = values['--session-pid'];
  const [pr, workspaceArg, intervalArg] = rest;
  const intervalSec = parseInt(intervalArg || '30');

  if (!pr) {
    console.error(USAGE);
    process.exit(1);
  }

  // 他スクリプト（poll-pr.js等）と同じ workspace 解決順（引数 >
  // GH_MAESTRO_WORKSPACE env > CWD探索）に統一する。素の process.cwd() フォールバックだと、CWD が
  // ホームディレクトリ配下のどこか等に誤解決される余地が残るため使わない
  // （Issue #214: process-lifecycle.js の PID registry が managed root と衝突する事故の一因）。
  const workspace = resolveWorkspace(workspaceArg);
  if (!workspace) {
    console.error('poll-reviews: ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');
    process.exit(1);
  }

  const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8' }).stdout.trim();

  const stateDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `poll-state-${pr}`);
  if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, '');
  const shaFile = path.join(stateDir, `poll-sha-${pr}`);
  const testStatusFile = path.join(stateDir, `poll-test-status-${pr}`);

  // ── ライフサイクル管理 ─────────────────────────────────────────────────

  const sessionPid = resolveSessionPid(sessionPidArg);

  // PID再利用検知のため、起動時に親セッションの起動時刻を捕捉する（best-effort。
  // 取得失敗時は expectedStartTime=null となり isProcessAlive のみの従来判定にフォールバック）。
  const expectedStartTime = getProcessStartTime(sessionPid);
  const checkParent = createDeadManSwitch(sessionPid, { expectedStartTime });

  // PID registry に自己登録
  registerProcess(workspace, { script: 'poll-reviews.js' });

  function cleanup() {
    lifecycleCleanup(workspace, () => {
      try { fs.unlinkSync(stateFile); } catch {}
      try { fs.unlinkSync(shaFile); } catch {}
      try { fs.unlinkSync(testStatusFile); } catch {}
    });
  }

  process.on('SIGINT',  () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  // 異常終了（非ゼロexit）を orchestrator へ通知する（Issue #289 受け入れ条件3）。
  // 正常終了（exit 0: SIGINT/SIGTERM/親セッション消滅/MERGED/CLOSED）では何もしない。
  // process.on('exit') は同期コードしか実行できないため、共有ヘルパーは spawnSync で
  // 同期投稿する（best-effort・throwしない）。
  process.on('exit', () => { notifyWatchdogExit({ workspace, scriptName: 'poll-reviews.js' }); });

  function knownIds() {
    return new Set(fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean));
  }

  function recordId(id) {
    fs.appendFileSync(stateFile, id + '\n');
  }

  // gh 呼び出しは終了コードを必ず確認する。GitHub障害中は gh がエラーレスポンス
  // （404 JSON・切れた出力等）を stdout に出して非ゼロ終了しうる。status を見ずに
  // stdout を消費すると、そのゴミが state に記録され REVIEW_COMMENT 断片として中継され続ける。
  // 失敗時は null を返し（呼び出し側はそのサイクル/セクションをスキップ）、エラーは stderr へ出す
  // （stdout はイベントストリームなので混ぜない）。
  function ghCapture(args) {
    const r = spawnSync('gh', args, { encoding: 'utf8' });
    if (r.status !== 0) {
      process.stderr.write(`poll-reviews: gh ${args.join(' ')} 失敗 (status ${r.status}): ${(r.stderr || '').toString().trim()}\n`);
      return null;
    }
    return r.stdout;
  }

  const inlineJq = `.[] | [(.id | tostring), .path, ((.original_line // "?") | tostring), .user.login, (.body | gsub("\\n"; " "))] | join("|")`;
  const reviewsJq = `.[] | [(.id | tostring), .user.login, .state, (.body | gsub("\\n"; " "))] | join("|")`;

  // GitHubアクセスの失敗をサイレントに握り潰さない。stderr は Monitor に拾われるとは限らないため、
  // orchestrator に確実に届く stdout へ、状態遷移（正常→劣化／劣化→復旧）のときだけイベントを出す
  // （毎周回出すとスパムになるので遷移時のみ）。これにより持続的な障害が可視化され、
  // orchestrator が「まだレビューが来ないだけ」と誤解して無限に待つのを防ぐ。
  let degraded = false;
  function noteCycleResult(hadError) {
    const t = pollDegradationTransition(degraded, hadError);
    degraded = t.degraded;
    if (t.emit === 'POLL_ERROR') {
      process.stdout.write('POLL_ERROR:review監視のGitHubアクセスが失敗しています（一時的な可能性。復旧まで再試行を継続します）\n');
    } else if (t.emit === 'POLL_RECOVERED') {
      process.stdout.write('POLL_RECOVERED\n');
    }
  }

  (async () => {
    while (true) {
      // dead-man's switch: 親セッション生存確認
      if (!checkParent()) {
        console.error(`poll-reviews: parent session (pid ${sessionPid}) is dead — exiting`);
        cleanup();
        process.exit(0);
      }

      const prJson = ghCapture(['pr', 'view', pr, '--repo', repo,
        '--json', 'state,headRefOid,author', '-q', '[.state, .headRefOid, (.author.login // "")] | join("|")']);
      // PR状態が取れないサイクルは以降を丸ごとスキップ（誤った差分検知・中継を防ぐ）。
      if (prJson === null) {
        noteCycleResult(true);
        await new Promise(r => setTimeout(r, intervalSec * 1000));
        continue;
      }
      const [state, headSha, prAuthor] = prJson.trim().split('|');

      // 終端イベント（MERGED / CLOSED）を検出したら監視を終了する。
      // CLOSED（却下・キャンセル）も終端として扱う（Issue #289: 従来は MERGED のみ終端だった
      // ため、CLOSED された PR を監視し続けて poll-pr.js が新 PR を検出できず機能死を起こした）。
      const terminalEvent = reviewTerminalEvent(state, pr);
      if (terminalEvent) {
        process.stdout.write(`${terminalEvent}\n`);
        cleanup();
        process.exit(0);
      }

      let isPushEvent = false;
      const prevSha = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim() : '';
      if (headSha && headSha !== prevSha) {
        fs.writeFileSync(shaFile, headSha);
        if (prevSha) {
          process.stdout.write(`PR_PUSH:${headSha}\n`);
          isPushEvent = true;
        }
      }

      const known = knownIds();
      let hadError = false;

      const inlineOut = ghCapture(['api', `repos/${repo}/pulls/${pr}/comments`,
        '--paginate', '-q', inlineJq]);
      if (inlineOut !== null) {
        for (const line of inlineOut.split('\n').filter(Boolean)) {
          const sep = line.indexOf('|');
          const id = line.slice(0, sep);
          if (!isValidCommentId(id) || known.has(id)) continue;
          recordId(id);
          process.stdout.write(`REVIEW_COMMENT:${line.slice(sep + 1)}\n`);
        }
      } else {
        hadError = true;
      }

      // PR コメント（テスト結果申告マーカーの抽出・判定もここで行う）
      const commentsJson = ghCapture(['pr', 'view', pr, '--repo', repo,
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
        ].join(':');
        const prevEvalKey = fs.existsSync(testStatusFile) ? fs.readFileSync(testStatusFile, 'utf8').trim() : '';

        if (evalKey !== prevEvalKey || isPushEvent) {
          fs.writeFileSync(testStatusFile, evalKey);
          process.stdout.write(formatTestStatusEvent(testEvaluation) + '\n');
        }

        for (const event of buildPrCommentRelayEvents(commentsList, known)) {
          recordId(event.id);
          process.stdout.write(`${event.line}\n`);
        }
      } else {
        hadError = true;
      }

      const reviewsOut = ghCapture(['api', `repos/${repo}/pulls/${pr}/reviews`,
        '--paginate', '-q', reviewsJq]);
      if (reviewsOut !== null) {
        for (const line of reviewsOut.split('\n').filter(Boolean)) {
          const sep = line.indexOf('|');
          const id = line.slice(0, sep);
          if (!isValidCommentId(id) || known.has(id)) continue;
          recordId(id);
          const rest = line.slice(sep + 1); // user|state|body
          const [user, state, ...bodyParts] = rest.split('|');
          const body = bodyParts.join('|');
          // APPROVED/CHANGES_REQUESTED は body が空でも emit（マージ判断に必要）
          if (body.trim() || state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
            process.stdout.write(`PR_REVIEW:${user}:${state}:${body}\n`);
          }
        }
      } else {
        hadError = true;
      }

      noteCycleResult(hadError);
      await new Promise(r => setTimeout(r, intervalSec * 1000));
    }
  })();
}
