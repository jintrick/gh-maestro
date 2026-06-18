#!/usr/bin/env node
// Usage: node poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS]
// Polls for review comments, commit pushes, and merge status. Emits:
//   REVIEW_COMMENT:<path>:<line>|<user>:<body>
//   PR_COMMENT:<user>:<body>
//   PR_PUSH:<sha>
//   PR_MERGED:<PR>
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [,, pr, workspace, intervalArg] = process.argv;
const intervalSec = parseInt(intervalArg || '30');

if (!pr) {
  console.error('Usage: poll-reviews.js <PR> [WORKSPACE] [INTERVAL_SECONDS]');
  process.exit(1);
}

const repo = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
  { encoding: 'utf8' }).stdout.trim();

const stateDir = path.join(workspace || process.cwd(), '.gh-maestro');
fs.mkdirSync(stateDir, { recursive: true });
const stateFile = path.join(stateDir, `poll-state-${pr}`);
if (!fs.existsSync(stateFile)) fs.writeFileSync(stateFile, '');
const shaFile = path.join(stateDir, `poll-sha-${pr}`);

function knownIds() {
  return new Set(fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean));
}

function recordId(id) {
  fs.appendFileSync(stateFile, id + '\n');
}

const inlineJq = `.[] | [(.id | tostring), .path, ((.original_line // "?") | tostring), .user.login, (.body | gsub("\\n"; " "))] | join("|")`;
const commentsJq = `.comments[] | [(.id | tostring), .author.login, (.body | gsub("\\n"; " "))] | join("|")`;

(async () => {
  let interval = intervalSec;
  while (true) {
    const prJson = spawnSync('gh', ['pr', 'view', pr, '--repo', repo,
      '--json', 'state,headRefOid', '-q', '[.state, .headRefOid] | join("|")'],
      { encoding: 'utf8' }).stdout.trim();
    const [state, headSha] = prJson.split('|');

    if (state === 'MERGED') {
      process.stdout.write(`PR_MERGED:${pr}\n`);
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

    await new Promise(r => setTimeout(r, intervalSec * 1000));
  }
})();
