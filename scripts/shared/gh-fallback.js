'use strict';
// gh-fallback.js — REST APIが劣化・障害中のときに GraphQL 相当の操作へフォールバックする共有ロジック
//
// 背景: 2026-07-17、GitHub REST APIが「Degraded Performance」障害を起こしたが、
// GraphQL API は無傷だった（docs/github-comm-plan.md §8 参照）。
// REST呼び出しがサーバ/ネットワーク起因で失敗した場合のみ GraphQL にフォールバックする。
// 4xx等のクライアントエラー（存在しない・権限なし等）はフォールバックしても
// 同じ理由で失敗するため対象外とし、そのまま呼び出し元に返す。

const { graphqlExec, parseGraphqlJson, _setGraphqlExec } = require('./graphql-client');

const SERVER_ERROR_RE = /HTTP 5\d\d/;
const RETRYABLE_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/**
 * REST呼び出し失敗が GraphQL フォールバック対象かどうかを判定する。
 *
 * @param {{ status?: number, stderr?: string, error?: { code?: string } }} result  spawnSync の戻り値
 * @returns {boolean}
 */
function isRetryableGhFailure(result) {
  if (!result || result.status === 0) return false;
  if (result.error && result.error.code && RETRYABLE_ERROR_CODES.has(result.error.code)) return true;
  return SERVER_ERROR_RE.test(result.stderr || '');
}

// ── gh api graphql 呼び出し ──────────────────────────────────────────────────
// 低レベル実行（graphqlExec / parseGraphqlJson）は graphql-client.js に切り出した。
// テストによる注入は graphql-client.js の _setGraphqlExec を経由し、本モジュールは
// それを _setGraphqlExec として再exportする（既存 tests/gh-fallback.test.js の互換）。

/**
 * 指定 Issue の GraphQL node ID を取得する。
 *
 * @param {string} owner
 * @param {string} name
 * @param {string|number} issueNumber
 * @param {object} [opts]
 * @returns {{ status: number, stdout: string, stderr: string, nodeId?: string }}
 */
function resolveIssueNodeId(owner, name, issueNumber, opts = {}) {
  const result = graphqlExec([
    '-f', 'query=query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){issue(number:$num){id}}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `num=${issueNumber}`,
  ], opts);
  if (result.status !== 0) return result;

  const parsed = parseGraphqlJson(result.stdout);
  const nodeId = parsed?.data?.repository?.issue?.id;
  if (!nodeId) {
    return { status: 1, stdout: '', stderr: 'gh-fallback: GraphQL応答からissue node IDを取得できませんでした' };
  }
  return { status: 0, stdout: result.stdout, stderr: '', nodeId };
}

/**
 * Issue コメントを GraphQL 経由で投稿する（`gh issue comment` の代替）。
 *
 * @param {{ repo: string, issue: string|number, body: string, opts?: object }} params
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function graphqlAddComment({ repo, issue, body, opts = {} }) {
  const [owner, name] = String(repo).split('/');
  const idResult = resolveIssueNodeId(owner, name, issue, opts);
  if (idResult.status !== 0) return idResult;

  const commentResult = graphqlExec([
    '-f', 'query=mutation($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{url}}}}',
    '-f', `id=${idResult.nodeId}`,
    '-F', 'body=@-',
  ], { ...opts, input: body });
  if (commentResult.status !== 0) return commentResult;

  const parsed = parseGraphqlJson(commentResult.stdout);
  const url = parsed?.data?.addComment?.commentEdge?.node?.url;
  if (!url) {
    return { status: 1, stdout: '', stderr: 'gh-fallback: GraphQL応答からコメントURLを取得できませんでした' };
  }
  return { status: 0, stdout: url + '\n', stderr: '' };
}

/**
 * 指定 Issue の直近コメント一覧を GraphQL 経由で取得する（`gh api .../comments` の代替）。
 * GraphQLには REST の `since` 相当のサーバ側フィルタが無いため、直近100件を取得し
 * `since` が指定されていればクライアント側で created_at > since を判定して絞り込む。
 * 未読が100件を超える異常事態では取りこぼしうるが、フォールバックは短期障害時のみの
 * 利用と割り切る（docs/github-comm-plan.md §8）。databaseId は REST の数値コメントIDと
 * 同一なので、呼び出し元は既存の id ベースのロジックをそのまま使える。
 *
 * @param {{ repo: string, issue: string|number, since?: string|null, opts?: object }} params
 * @returns {{ status: number, stdout: string, stderr: string }}
 *   成功時 stdout は REST版と同じ形（コメントオブジェクトの配列。id は databaseId を使う）の JSON 文字列
 */
function graphqlListComments({ repo, issue, since = null, opts = {} }) {
  const [owner, name] = String(repo).split('/');
  const result = graphqlExec([
    '-f', 'query=query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){issue(number:$num){comments(last:100){nodes{databaseId body createdAt}}}}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `num=${issue}`,
  ], opts);
  if (result.status !== 0) return result;

  const parsed = parseGraphqlJson(result.stdout);
  const nodes = parsed?.data?.repository?.issue?.comments?.nodes;
  if (!Array.isArray(nodes)) {
    return { status: 1, stdout: '', stderr: 'gh-fallback: GraphQL応答からコメント一覧を取得できませんでした' };
  }
  const filtered = since ? nodes.filter((n) => n.createdAt > since) : nodes;
  const comments = filtered.map((n) => ({ id: n.databaseId, body: n.body, created_at: n.createdAt }));
  return { status: 0, stdout: JSON.stringify(comments), stderr: '' };
}

/**
 * commentId（REST数値ID = databaseId）からコメント本文を GraphQL 経由で取得する。
 * GraphQLにはdatabaseIdから直接1件を引くrootクエリが無いため、issueNumberが必須。
 *
 * @param {{ repo: string, issue: string|number, commentId: string|number, opts?: object }} params
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function graphqlCommentBody({ repo, issue, commentId, opts = {} }) {
  if (issue == null) {
    return { status: 1, stdout: '', stderr: 'gh-fallback: --issue が指定されていないためGraphQLフォールバックできません' };
  }
  const listResult = graphqlListComments({ repo, issue, opts });
  if (listResult.status !== 0) return listResult;

  const comments = JSON.parse(listResult.stdout);
  const target = comments.find((c) => String(c.id) === String(commentId));
  if (!target) {
    return { status: 1, stdout: '', stderr: `gh-fallback: コメント ${commentId} が見つかりませんでした` };
  }
  return { status: 0, stdout: target.body, stderr: '' };
}

/**
 * Issue を GraphQL 経由で作成する（`gh issue create` の代替）。
 *
 * @param {{ repo: string, title: string, body: string, opts?: object }} params
 * @returns {{ status: number, stdout: string, stderr: string }}
 *   成功時 stdout は REST版と同じ `<url>` 形式
 */
function graphqlCreateIssue({ repo, title, body, opts = {} }) {
  const [owner, name] = String(repo).split('/');
  const repoIdResult = graphqlExec([
    '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
  ], opts);
  if (repoIdResult.status !== 0) return repoIdResult;

  const repoParsed = parseGraphqlJson(repoIdResult.stdout);
  const repoId = repoParsed?.data?.repository?.id;
  if (!repoId) {
    return { status: 1, stdout: '', stderr: 'gh-fallback: GraphQL応答からrepository IDを取得できませんでした' };
  }

  const createResult = graphqlExec([
    '-f', 'query=mutation($repoId:ID!,$title:String!,$body:String!){createIssue(input:{repositoryId:$repoId,title:$title,body:$body}){issue{number url}}}',
    '-f', `repoId=${repoId}`,
    '-f', `title=${title}`,
    '-F', 'body=@-',
  ], { ...opts, input: body });
  if (createResult.status !== 0) return createResult;

  const parsed = parseGraphqlJson(createResult.stdout);
  const url = parsed?.data?.createIssue?.issue?.url;
  if (!url) {
    return { status: 1, stdout: '', stderr: 'gh-fallback: GraphQL応答からissue URLを取得できませんでした' };
  }
  return { status: 0, stdout: url + '\n', stderr: '' };
}

module.exports = {
  isRetryableGhFailure,
  graphqlAddComment,
  graphqlListComments,
  graphqlCommentBody,
  graphqlCreateIssue,
  _setGraphqlExec,
};
