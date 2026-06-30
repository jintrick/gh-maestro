#!/usr/bin/env node
// Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS]
// Polls for review comments, commit pushes, and merge status. Emits:
//   REVIEW_COMMENT:<path>:<line>|<user>:<body>
//   PR_COMMENT:<user>:<body>
//   PR_REVIEW:<user>:<state>:<body>
//   PR_PUSH:<sha>
//   PR_MERGED:<PR>
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const USAGE = `poll-reviews.js — PR のレビューコメント・push・マージ状態をポーリングする

Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS]

Arguments:
  <PR>                対象の PR 番号
  [WORKSPACE]         状態ファイルを置くワークスペース（デフォルト CWD）
  [INTERVAL_SECONDS]  ポーリング間隔（秒、デフォルト 30）

Output (stdout):
  REVIEW_COMMENT:<path>:<line>|<user>:<body>  インラインレビューコメント
  PR_COMMENT:<user>:<body>                    PR 全体コメント
  PR_REVIEW:<user>:<state>:<body>             正式レビュー提出（APPROVED/CHANGES_REQUESTED/COMMENTED）
  PR_PUSH:<sha>                               新しいコミットが push された
  PR_MERGED:<PR>                              マージ完了（このとき終了する）

PR_MERGED を検出するまで永続的にポーリングする。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const [pr, workspace, intervalArg] = argv;
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

function cleanup() {
  try { fs.unlinkSync(stateFile); } catch (_) {}
  try { fs.unlinkSync(shaFile); } catch (_) {}
}
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

function knownIds() {
  return new Set(fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean));
}

function recordId(id) {
  fs.appendFileSync(stateFile, id + '\n');
}

const inlineJq = `.[] | [(.id | tostring), .path, ((.original_line // "?") | tostring), .user.login, (.body | gsub("\\n"; " "))] | join("|")`;
const commentsJq = `.comments[] | [(.id | tostring), .author.login, (.body | gsub("\\n"; " "))] | join("|")`;
const reviewsJq = `.[] | [(.id | tostring), .user.login, .state, (.body | gsub("\\n"; " "))] | join("|")`;

(async () => {
  let interval = intervalSec;
  while (true) {
    const prJson = spawnSync('gh', ['pr', 'view', pr, '--repo', repo,
      '--json', 'state,headRefOid', '-q', '[.state, .headRefOid] | join("|")'],
      { encoding: 'utf8' }).stdout.trim();
    const [state, headSha] = prJson.split('|');

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

    const inlineOut = spawnSync('gh', ['api', `repos/${repo}/pulls/${pr}/comments`,
      '--paginate', '-q', inlineJq], { encoding: 'utf8' }).stdout;
    for (const line of inlineOut.split('\n').filter(Boolean)) {
      const sep = line.indexOf('|');
      const id = line.slice(0, sep);
      if (!known.has(id)) {
        recordId(id);
        process.stdout.write(`REVIEW_COMMENT:${line.slice(sep + 1)}\n`);
      }
    }

    const commentsOut = spawnSync('gh', ['pr', 'view', pr, '--repo', repo,
      '--json', 'comments', '-q', commentsJq], { encoding: 'utf8' }).stdout;
    for (const line of commentsOut.split('\n').filter(Boolean)) {
      const sep = line.indexOf('|');
      const id = line.slice(0, sep);
      if (!known.has(id)) {
        recordId(id);
        process.stdout.write(`PR_COMMENT:${line.slice(sep + 1)}\n`);
      }
    }

    const reviewsOut = spawnSync('gh', ['api', `repos/${repo}/pulls/${pr}/reviews`,
      '--paginate', '-q', reviewsJq], { encoding: 'utf8' }).stdout;
    for (const line of reviewsOut.split('\n').filter(Boolean)) {
      const sep = line.indexOf('|');
      const id = line.slice(0, sep);
      if (!known.has(id)) {
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
