#!/usr/bin/env node
// Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS] [--session-pid <pid>]
// Polls for review comments, commit pushes, and merge status. Emits:
//   REVIEW_COMMENT:<path>:<line>|<user>:<body>
//   PR_COMMENT:<user>:<body>
//   PR_REVIEW:<user>:<state>:<body>
//   PR_PUSH:<sha>
//   PR_MERGED:<PR>
//   POLL_ERROR:<detail>  (GitHubアクセスが失敗し始めたとき。遷移時のみ)
//   POLL_RECOVERED       (失敗から復旧したとき。遷移時のみ)
'use strict';

const { spawnSync } = require('./child-process');
const fs = require('fs');
const path = require('path');
const { parseFlags, resolveWorkspace, hasGenuineHelpRequest } = require('./shared/workspace');
const {
  resolveSessionPid,
  createDeadManSwitch,
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
  PR_MERGED:<PR>                              マージ完了（このとき終了する）
  POLL_ERROR:<detail>                         GitHubアクセスが失敗し始めた（遷移時のみ。再試行は継続）
  POLL_RECOVERED                              失敗から復旧した（遷移時のみ）

PR_MERGED を検出するまで永続的にポーリングする。
ポーリングループの毎周回で親セッションの生存を確認し（dead-man's switch）、
消滅時はPID registryを解除して自動exitする。`;

/**
 * GitHub のコメント/レビューIDは正の整数。gh のエラーレスポンス（404 JSON 等）や
 * 切れた出力の断片が state に記録されたり REVIEW_COMMENT として中継されたりするのを防ぐため、
 * 記録・中継の前に必ずこれで検証する。
 * @param {string} id
 * @returns {boolean}
 */
function isValidCommentId(id) {
  return /^[0-9]+$/.test(id);
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

module.exports = { isValidCommentId, pollDegradationTransition };

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
    if (hasGenuineHelpRequest(argv, err.errors)) {
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

  // 他スクリプト（poll-pr.js等）と同じ workspace 解決順（GH_MAESTRO_WORKSPACE env >
  // 引数 > CWD探索）に統一する。素の process.cwd() フォールバックだと、CWD が
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

  // ── ライフサイクル管理 ─────────────────────────────────────────────────

  const sessionPid = resolveSessionPid(sessionPidArg);
  const checkParent = createDeadManSwitch(sessionPid);

  // PID registry に自己登録
  registerProcess(workspace, { script: 'poll-reviews.js' });

  function cleanup() {
    lifecycleCleanup(workspace, () => {
      try { fs.unlinkSync(stateFile); } catch {}
      try { fs.unlinkSync(shaFile); } catch {}
    });
  }

  process.on('SIGINT',  () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

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
  const commentsJq = `.comments[] | [(.id | tostring), .author.login, (.body | gsub("\\n"; " "))] | join("|")`;
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
        '--json', 'state,headRefOid', '-q', '[.state, .headRefOid] | join("|")']);
      // PR状態が取れないサイクルは以降を丸ごとスキップ（誤った差分検知・中継を防ぐ）。
      if (prJson === null) {
        noteCycleResult(true);
        await new Promise(r => setTimeout(r, intervalSec * 1000));
        continue;
      }
      const [state, headSha] = prJson.trim().split('|');

      if (state === 'MERGED') {
        process.stdout.write(`PR_MERGED:${pr}\n`);
        cleanup();
        process.exit(0);
      }

      const prevSha = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, 'utf8').trim() : '';
      if (headSha && headSha !== prevSha) {
        fs.writeFileSync(shaFile, headSha);
        if (prevSha) {
          process.stdout.write(`PR_PUSH:${headSha}\n`);
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

      const commentsOut = ghCapture(['pr', 'view', pr, '--repo', repo,
        '--json', 'comments', '-q', commentsJq]);
      if (commentsOut !== null) {
        for (const line of commentsOut.split('\n').filter(Boolean)) {
          const sep = line.indexOf('|');
          const id = line.slice(0, sep);
          if (!isValidCommentId(id) || known.has(id)) continue;
          recordId(id);
          process.stdout.write(`PR_COMMENT:${line.slice(sep + 1)}\n`);
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
