'use strict';
// discussion-graphql.js — GitHub Discussions のドメイン関数群
//
// 背景: Discussions は REST API が存在しないため、読み書きはすべて GraphQL
// （`gh api graphql`）で行う。低レベル実行（graphqlExec / parseGraphqlJson /
// isGraphqlSuccess）は graphql-client.js に一元化し、本モジュールはクエリ構築・
// 応答パース・ドメイン値の抽出だけを担う（gh-comments.js の「低レベル実行 + ドメイン」
// 分離構造を GraphQL 側でも踏襲）。
//
// 呼び出し形式は gh-fallback.js を踏襲する:
//   - 変数は `-f key=value`（文字列フィールド・IDフィールドとも）で渡す
//     （graphqlAddComment / graphqlCreateIssue が ID を `-f` で渡す既存実装に合わせる）
//   - 数値（discussion number）は型を保つため `-F key=value` で渡す
//   - 本文（body）は `-F 'body=@-'` + opts.input（stdin 渡し。stdin マーカーは
//     `-F`（raw-field）でしか解釈されないため body のみ `-F` を使う）
//   - GraphQL errors 配列は status 非0 相当として扱う（isGraphqlSuccess で判定）
//
// 戻り値の方針: 成功時は抽出したドメイン値、失敗時は null / false / 空配列を返し、
// 呼び出し元（run-council.js）がフェイルクローズ判定を行う。外部コマンドの失敗は
// 成功と断定しない（fail-closed-safety-guards ルール準拠）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { graphqlExec, parseGraphqlJson, isGraphqlSuccess } = require('./graphql-client');

/**
 * リポジトリを owner/name に分割する。形式不正時は空文字が入る。
 * @param {string} repo  `owner/name`
 * @returns {{ owner: string, name: string }}
 */
function splitRepo(repo) {
  const parts = String(repo).split('/');
  return { owner: parts[0] || '', name: parts[1] || '' };
}

/**
 * 対象リポジトリで Discussions が有効かどうかを確認する（execution 前の事前確認用）。
 * API 呼び出し自体が失敗した場合も false を返す（フェイルクローズ。安全と確認
 * できない場合は有効と断定しない）。
 *
 * @param {string} repo  `owner/name`
 * @returns {boolean}
 */
function hasDiscussionsEnabled(repo) {
  const { owner, name } = splitRepo(repo);
  const result = graphqlExec([
    '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){hasDiscussionsEnabled}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
  ]);
  if (!isGraphqlSuccess(result)) return false;
  const parsed = parseGraphqlJson(result.stdout);
  return Boolean(parsed?.data?.repository?.hasDiscussionsEnabled);
}

/**
 * 対象リポジトリの Discussion カテゴリ一覧を取得する。未指定カテゴリを決定的に
 * 選択できるよう `{ id, name }` の配列を返す。失敗時は空配列（呼び出し元が
 * フェイルクローズ判定）。
 *
 * @param {string} repo  `owner/name`
 * @returns {Array<{ id: string, name: string }>}
 */
function discussionCategories(repo) {
  const { owner, name } = splitRepo(repo);
  const result = graphqlExec([
    '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussionCategories(first:100){nodes{id name}}}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
  ]);
  if (!isGraphqlSuccess(result)) return [];
  const parsed = parseGraphqlJson(result.stdout);
  const nodes = parsed?.data?.repository?.discussionCategories?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .filter((n) => n && typeof n.id === 'string' && n.id.length > 0 && typeof n.name === 'string' && n.name.length > 0)
    .map((n) => ({ id: n.id, name: n.name }));
}

/**
 * Discussion を1件作成し、作成結果（id / number / url / title）を返す。失敗時は null。
 * repositoryId / categoryId は GraphQL ID（不透明文字列）のため `-f` で渡す
 * （graphqlCreateIssue が repositoryId を `-f` で渡す既存実装に合わせる）。
 *
 * @param {string} repo  `owner/name`
 * @param {string} title
 * @param {string} body
 * @param {string} categoryId
 * @param {object} [opts]
 * @returns {null | { id: string, number: number, url: string, title: string }}
 */
function createDiscussion(repo, title, body, categoryId, opts = {}) {
  const { owner, name } = splitRepo(repo);
  const repoIdResult = graphqlExec([
    '-f', 'query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
  ], opts);
  if (!isGraphqlSuccess(repoIdResult)) return null;
  const repoParsed = parseGraphqlJson(repoIdResult.stdout);
  const repoId = repoParsed?.data?.repository?.id;
  if (!repoId) return null;

  const createResult = graphqlExec([
    '-f', 'query=mutation($repositoryId:ID!,$categoryId:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repositoryId,categoryId:$categoryId,title:$title,body:$body}){discussion{id number url title}}}',
    '-f', `repositoryId=${repoId}`,
    '-f', `categoryId=${categoryId}`,
    '-f', `title=${title}`,
    '-F', 'body=@-',
  ], { ...opts, input: body });
  if (!isGraphqlSuccess(createResult)) return null;

  const parsed = parseGraphqlJson(createResult.stdout);
  const d = parsed?.data?.createDiscussion?.discussion;
  if (!d || typeof d.id !== 'string' || typeof d.number !== 'number' || typeof d.url !== 'string' || typeof d.title !== 'string') {
    return null;
  }
  return { id: d.id, number: d.number, url: d.url, title: d.title };
}

/**
 * Discussion へコメントを投稿し、コメント URL を返す。失敗時は null。
 * 意見・投票・要約コメントの投稿に使う。
 *
 * @param {string} discussionId  GraphQL discussion ID
 * @param {string} body
 * @param {object} [opts]
 * @returns {string|null}  コメント URL
 */
function addDiscussionComment(discussionId, body, opts = {}) {
  const result = graphqlExec([
    '-f', 'query=mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{id url}}}',
    '-f', `id=${discussionId}`,
    '-F', 'body=@-',
  ], { ...opts, input: body });
  if (!isGraphqlSuccess(result)) return null;
  const parsed = parseGraphqlJson(result.stdout);
  const url = parsed?.data?.addDiscussionComment?.comment?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * 指定番号の Discussion を取得して復元する（--resume 時の再検証用）。
 * 見つからない場合・失敗時は null（呼び出し元がフェイルクローズ判定）。
 *
 * @param {string} repo  `owner/name`
 * @param {number} number
 * @param {object} [opts]
 * @returns {null | { id: string, number: number, url: string, title: string }}
 */
function discussion(repo, number, opts = {}) {
  const { owner, name } = splitRepo(repo);
  const result = graphqlExec([
    '-f', 'query=query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){discussion(number:$num){id number url title}}}',
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
    '-F', `num=${number}`,
  ], opts);
  if (!isGraphqlSuccess(result)) return null;
  const parsed = parseGraphqlJson(result.stdout);
  const d = parsed?.data?.repository?.discussion;
  if (!d || typeof d.id !== 'string' || typeof d.number !== 'number' || typeof d.url !== 'string') return null;
  return { id: d.id, number: d.number, url: d.url, title: typeof d.title === 'string' ? d.title : '' };
}

module.exports = {
  hasDiscussionsEnabled,
  discussionCategories,
  createDiscussion,
  addDiscussionComment,
  discussion,
};
