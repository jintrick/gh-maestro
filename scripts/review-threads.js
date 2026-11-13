#!/usr/bin/env node
'use strict';

// Review Manager のレビュースレッドを一覧し、返信・Resolve する。
// GraphQL の実行と成功判定は shared/graphql-client.js に集約する。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./shared/child-process');
const { graphqlExec, parseGraphqlJson, isGraphqlSuccess } = require('./shared/graphql-client');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { reviewArtifactPath } = require('./shared/review-manager-paths');
const { loadReviewFindings } = require('./read-review-findings');
const { reviewFindingMarker, parseReviewFindingMarker } = require('./shared/review-finding-marker');
const { toWinPath } = require('./shared/win-path');

const USAGE = `review-threads.js — Review Manager のスレッドを照会・返信・Resolve する

Usage:
  node review-threads.js list --pr <N> --repo <owner/repo> [--workspace <path>]
  node review-threads.js status --pr <N> --repo <owner/repo>
  node review-threads.js reply --pr <N> --repo <owner/repo> --comment-id <N> --body-file <path>
  node review-threads.js resolve --thread-id <GraphQL-ID>

Options:
  --pr <N>               対象 PR 番号（list/status/reply で必須）
  --repo <owner/repo>    GitHub リポジトリ（list/status/reply で必須）
  --workspace <path>     manager.json と現世代の指摘を照合する workspace（list で任意）
  --comment-id <N>       返信対象スレッドの先頭コメントID（reply で必須）
  --body-file <path>     返信本文の UTF-8 ファイル（reply で必須）
  --thread-id <ID>       Resolve 対象の GraphQL review thread ID（resolve で必須）
  --help, -h             このヘルプを表示する

list は Review Manager finding マーカー付きスレッドと返信先を JSON で出力する。
status は PR 全体と Review Manager 指摘の未解決数を JSON で出力する。
返信・Resolve が失敗した場合は非0終了し、後続処理を成功扱いしない。`;

const QUERIES = {
  reviewThreads: 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved subjectType path line comments(first:1){nodes{databaseId url body}}}pageInfo{hasNextPage endCursor}}}}}',
  resolveReviewThread: 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}',
};

function splitRepo(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`--repo は owner/repo 形式で指定してください: ${JSON.stringify(repo)}`);
  }
  const [owner, name] = repo.split('/');
  return { owner, name };
}

function assertPr(pr) {
  const value = String(pr);
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--pr は正の整数で指定してください: ${JSON.stringify(pr)}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`--pr が安全な整数の範囲を超えています: ${JSON.stringify(pr)}`);
  return number;
}

function graphqlData(result, operation) {
  if (!isGraphqlSuccess(result)) {
    const parsed = parseGraphqlJson(result && result.stdout);
    const detail = parsed?.errors?.map((error) => error.message).join('; ')
      || result?.stderr
      || `終了コード ${result?.status ?? 'unknown'} または不正なJSON応答`;
    throw new Error(`${operation} の GitHub GraphQL API 呼び出しに失敗しました: ${detail}`);
  }
  const parsed = parseGraphqlJson(result.stdout);
  if (!parsed || !parsed.data) throw new Error(`${operation} の GraphQL 応答に data がありません`);
  return parsed.data;
}

function parseReviewThread(thread, pr) {
  if (!thread || typeof thread.id !== 'string' || typeof thread.isResolved !== 'boolean'
    || !['FILE', 'LINE'].includes(thread.subjectType)
    || typeof thread.path !== 'string' || !Array.isArray(thread.comments?.nodes)
    || thread.comments.nodes.length < 1) {
    throw new Error('reviewThreads に必須フィールドが欠けた thread があります');
  }
  const comment = thread.comments.nodes[0];
  if (!comment || !Number.isSafeInteger(comment.databaseId) || comment.databaseId < 1
    || typeof comment.url !== 'string' || typeof comment.body !== 'string') {
    throw new Error(`thread ${thread.id} の先頭コメントが不正です`);
  }
  const marker = parseReviewFindingMarker(comment.body);
  const identity = marker && marker.pr === String(pr) ? marker : null;
  const firstLine = comment.body.split(/\r?\n/, 1)[0];
  const separator = firstLine.indexOf(': ');
  return {
    reviewManager: Boolean(identity),
    finding: identity?.finding ?? null,
    generation: identity?.sha256 ?? null,
    marker: identity?.marker ?? null,
    threadId: thread.id,
    subjectType: thread.subjectType,
    commentId: comment.databaseId,
    url: comment.url,
    path: thread.path,
    summary: separator >= 0 ? firstLine.slice(separator + 2) : firstLine,
    isResolved: thread.isResolved,
  };
}

function allReviewThreads(pr, repo, deps = {}) {
  const number = assertPr(pr);
  const { owner, name } = splitRepo(repo);
  const exec = deps.graphqlExec || graphqlExec;
  const threads = [];
  const cursors = new Set();
  let after = null;
  let pageCount = 0;

  while (true) {
    pageCount++;
    if (pageCount > 1000) throw new Error(`PR #${number} の reviewThreads が1000ページを超えました`);
    const args = [
      '-f', `query=${QUERIES.reviewThreads}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      '-F', `number=${number}`,
    ];
    if (after !== null) args.push('-f', `after=${after}`);
    const data = graphqlData(exec(args), 'reviewThreads');
    const connection = data.repository?.pullRequest?.reviewThreads;
    if (!connection || !Array.isArray(connection.nodes)
      || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error(`PR #${number} の reviewThreads を完全な形で取得できません`);
    }
    for (const thread of connection.nodes) {
      threads.push(parseReviewThread(thread, number));
    }
    if (!connection.pageInfo.hasNextPage) break;
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || cursor.length === 0 || cursors.has(cursor)) {
      throw new Error(`PR #${number} の reviewThreads ページカーソルが不正です`);
    }
    cursors.add(cursor);
    after = cursor;
  }

  const seen = new Set();
  for (const entry of threads.filter((thread) => thread.reviewManager)) {
    if (seen.has(entry.marker)) throw new Error(`finding マーカーに対応するスレッドが複数あります: ${entry.marker}`);
    seen.add(entry.marker);
  }
  return threads;
}

function reviewManagerThreads(pr, repo, deps = {}) {
  return allReviewThreads(pr, repo, deps).filter((thread) => thread.reviewManager);
}

function reviewThreadStatus(pr, repo, deps = {}) {
  const threads = allReviewThreads(pr, repo, deps);
  const reviewManager = threads.filter((thread) => thread.reviewManager);
  return {
    pr: Number(pr),
    totalReviewThreads: threads.length,
    unresolvedReviewThreads: threads.filter((thread) => !thread.isResolved).length,
    totalReviewManagerThreads: reviewManager.length,
    unresolvedReviewManagerThreads: reviewManager.filter((thread) => !thread.isResolved).length,
  };
}

function currentReviewManagerThreads(pr, repo, workspace, deps = {}) {
  const { payload } = loadReviewFindings(workspace, pr);
  const artifactPath = reviewArtifactPath(workspace, pr, '.json');
  const bytes = fs.readFileSync(artifactPath);
  const allThreads = reviewManagerThreads(pr, repo, deps);
  const byMarker = new Map(allThreads.map((thread) => [thread.marker, thread]));
  return payload.findings.map((finding, index) => {
    const marker = reviewFindingMarker(pr, bytes, index + 1);
    const thread = byMarker.get(marker);
    if (!thread) throw new Error(`manager.json の finding ${index + 1} に対応するスレッドがありません`);
    return {
      ...thread,
      finding: index + 1,
      path: finding.path,
      summary: finding.summary,
    };
  });
}

function postReply(pr, repo, commentId, body, spawnFn = spawnSync) {
  const pullNumber = assertPr(pr);
  const { owner, name } = splitRepo(repo);
  if (!/^[1-9]\d*$/.test(String(commentId)) || !Number.isSafeInteger(Number(commentId))) {
    throw new Error('--comment-id は正の整数で指定してください');
  }
  if (typeof body !== 'string' || body.trim().length === 0) throw new Error('返信本文が空です');
  const endpoint = `repos/${owner}/${name}/pulls/${pullNumber}/comments/${commentId}/replies`;
  const result = spawnFn('gh', [
    'api', endpoint,
    '-X', 'POST',
    '-F', 'body=@-',
  ], { encoding: 'utf8', input: body });
  if (result.error || result.status !== 0) {
    throw new Error(`レビュースレッドへの返信に失敗しました: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`返信APIのJSON応答を読めません: ${error.message}`);
  }
  const url = response && (response.html_url || response.url);
  if (!response || !Number.isSafeInteger(response.id) || response.id < 1 || typeof url !== 'string' || !url) {
    throw new Error('返信APIがコメントIDまたはURLを返しませんでした');
  }
  return { commentId: response.id, url };
}

function resolveReviewThread(threadId, deps = {}) {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId !== threadId.trim()) throw new Error('--thread-id を指定してください');
  const exec = deps.graphqlExec || graphqlExec;
  const data = graphqlData(exec([
    '-f', `query=${QUERIES.resolveReviewThread}`,
    '-f', `threadId=${threadId}`,
  ]), 'resolveReviewThread');
  const thread = data.resolveReviewThread?.thread;
  if (!thread || thread.id !== threadId || thread.isResolved !== true) {
    throw new Error(`thread ${threadId} が Resolve 済みとして返りませんでした`);
  }
  return { threadId: thread.id, isResolved: true };
}

function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseFlags(argv, {
      flags: {
        '--pr': {},
        '--repo': {},
        '--workspace': {},
        '--comment-id': {},
        '--body-file': {},
        '--thread-id': {},
      },
      booleans: ['--help', '-h'],
      positionals: { min: 1, max: 1 },
    });
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) return { mode: 'help' };
    throw new Error(error.errors.map((entry) => entry.message).join('; '));
  }
  if (parsed.values['--help'] || parsed.values['-h']) return { mode: 'help' };
  return { mode: 'run', command: parsed.rest[0], values: parsed.values };
}

function main(argv = process.argv.slice(2), deps = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return { code: 1, stderr: `review-threads: ${error.message}\n${USAGE}` };
  }
  if (args.mode === 'help') return { code: 0, stdout: USAGE };
  const values = args.values;
  try {
    const allowedFlags = {
      list: new Set(['--pr', '--repo', '--workspace']),
      status: new Set(['--pr', '--repo']),
      reply: new Set(['--pr', '--repo', '--comment-id', '--body-file']),
      resolve: new Set(['--thread-id']),
    }[args.command];
    if (!allowedFlags) throw new Error(`未知のコマンドです: ${args.command}`);
    const unexpected = Object.keys(values).filter((flag) => !allowedFlags.has(flag));
    if (unexpected.length) throw new Error(`${args.command} では使えないオプションです: ${unexpected.join(', ')}`);
    let result;
    if (args.command === 'list' || args.command === 'status') {
      if (!values['--pr'] || !values['--repo']) throw new Error(`${args.command} には --pr と --repo が必要です`);
      const pr = assertPr(values['--pr']);
      if (args.command === 'list' && values['--workspace']) {
        const workspace = resolveWorkspace(values['--workspace']);
        if (!workspace) throw new Error('--workspace を解決できません');
        result = currentReviewManagerThreads(pr, values['--repo'], workspace, deps);
      } else if (args.command === 'list') result = reviewManagerThreads(pr, values['--repo'], deps);
      else result = reviewThreadStatus(pr, values['--repo'], deps);
    } else if (args.command === 'reply') {
      if (!values['--pr'] || !values['--repo'] || !values['--comment-id'] || !values['--body-file']) {
        throw new Error('reply には --pr、--repo、--comment-id、--body-file が必要です');
      }
      const pr = assertPr(values['--pr']);
      const bodyFile = path.resolve(toWinPath(values['--body-file']));
      const body = fs.readFileSync(bodyFile, 'utf8');
      result = postReply(pr, values['--repo'], values['--comment-id'], body, deps.spawnSync || spawnSync);
    } else if (args.command === 'resolve') {
      if (!values['--thread-id']) throw new Error('resolve には --thread-id が必要です');
      result = resolveReviewThread(values['--thread-id'], deps);
    }
    return { code: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
  } catch (error) {
    return { code: 1, stderr: `review-threads: ${error.message}` };
  }
}

module.exports = {
  QUERIES,
  USAGE,
  splitRepo,
  assertPr,
  reviewManagerThreads,
  allReviewThreads,
  currentReviewManagerThreads,
  reviewThreadStatus,
  postReply,
  resolveReviewThread,
  parseArgs,
  main,
};

if (require.main === module) {
  const result = main();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
