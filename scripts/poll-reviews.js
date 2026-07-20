#!/usr/bin/env node
// Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS] [--session-pid <pid>]
// Polls for review comments, commit pushes, and merge status. Emits:
//   REVIEW_COMMENT:<path>:<line>|<user>:<body>
//   PR_COMMENT:<user>:<body>
//   PR_REVIEW:<user>:<state>:<body>
//   PR_PUSH:<sha>
//   PR_MERGED:<PR>
'use strict';

const { spawnSync } = require('./child-process');
const fs = require('fs');
const path = require('path');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');
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
  [WORKSPACE]         状態ファイルを置くワークスペース（デフォルト CWD）
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Options:
  --session-pid <pid>  監視対象のセッションPID（dead-man's switch用。省略時は自動検出）

Output (stdout):
  REVIEW_COMMENT:<path>:<line>|<user>:<body>  インラインレビューコメント
  PR_COMMENT:<user>:<body>                    PR 全体コメント
  PR_REVIEW:<user>:<state>:<body>             正式レビュー提出（APPROVED/CHANGES_REQUESTED/COMMENTED）
  PR_PUSH:<sha>                               新しいコミットが push された
  PR_MERGED:<PR>                              マージ完了（このとき終了する）

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

module.exports = { isValidCommentId };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--session-pid']);

  // exitFlagMiss（値欠落）を先に判定する。未消費の値トークンが rest に残るため、
  // それがたまたま "--help" と一致すると後段の hasHelpFlag が誤検出しうる。
  // 値欠落は常にエラー優先（フェイルクローズ）とする。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  const sessionPidArg = values['--session-pid'];
  const [pr, workspace, intervalArg] = rest;
  const intervalSec = parseInt(intervalArg || '30');

  if (!pr) {
    console.error(USAGE);
    process.exit(1);
  }

  const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8' }).stdout.trim();

  const stateDir = path.join(workspace || process.cwd(), '.gh-maestro');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `poll-state-${pr}`);
  if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, '');
  const shaFile = path.join(stateDir, `poll-sha-${pr}`);

  // ── ライフサイクル管理 ─────────────────────────────────────────────────

  const sessionPid = resolveSessionPid(sessionPidArg);
  const checkParent = createDeadManSwitch(sessionPid);

  // PID registry に自己登録
  registerProcess(workspace || process.cwd(), { script: 'poll-reviews.js' });

  function cleanup() {
    lifecycleCleanup(workspace || process.cwd(), () => {
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

  (async () => {
    let interval = intervalSec;
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
      }

      await new Promise(r => setTimeout(r, intervalSec * 1000));
    }
  })();
}
