'use strict';
// comment-author-trust.js — GitHubコメントの投稿者associationに基づく信頼判定
//
// REST APIのコメントは author_association、GraphQLやgh pr viewのコメントは
// authorAssociationという名前で同じ属性を返す。属性が欠落・未知の場合に
// write権限を確認できたことにはしない（フェイルクローズ）。

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * コメントオブジェクトから投稿者のリポジトリassociationを取得する。
 * RESTとGraphQLの応答形式を共有呼び出し元へ意識させないための正規化であり、
 * どちらの属性も無い場合はnullを返す。
 *
 * @param {unknown} comment
 * @returns {string|null}
 */
function getCommentAuthorAssociation(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return null;
  if (typeof comment.author_association === 'string') return comment.author_association;
  if (typeof comment.authorAssociation === 'string') return comment.authorAssociation;
  return null;
}

/**
 * コメント投稿者が、このリポジトリで信頼するassociationに属するか判定する。
 * associationが無い・未知・write権限を示さない場合はfalseを返す。
 *
 * @param {unknown} comment
 * @returns {boolean}
 */
function isTrustedCommentAuthor(comment) {
  const association = getCommentAuthorAssociation(comment);
  return association !== null && TRUSTED_ASSOCIATIONS.has(association);
}

module.exports = {
  TRUSTED_ASSOCIATIONS,
  getCommentAuthorAssociation,
  isTrustedCommentAuthor,
};
