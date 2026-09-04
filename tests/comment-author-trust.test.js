'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUSTED_ASSOCIATIONS,
  getCommentAuthorAssociation,
  isTrustedCommentAuthor,
} = require('../scripts/shared/comment-author-trust');

test('信頼するassociationはOWNER/MEMBER/COLLABORATORに限定される', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(isTrustedCommentAuthor({ author_association: association }), true, association);
    assert.equal(TRUSTED_ASSOCIATIONS.has(association), true, association);
  }
});

test('write権限を示さないassociationは信頼しない', () => {
  for (const association of ['CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'NONE', 'UNKNOWN']) {
    assert.equal(isTrustedCommentAuthor({ author_association: association }), false, association);
  }
});

test('associationが欠落・不正なコメントはフェイルクローズで信頼しない', () => {
  for (const comment of [null, undefined, {}, { author_association: null }, { author_association: 1 }, []]) {
    assert.equal(getCommentAuthorAssociation(comment), null);
    assert.equal(isTrustedCommentAuthor(comment), false);
  }
});

test('RESTとGraphQLのassociationフィールド名を受け付ける', () => {
  assert.equal(getCommentAuthorAssociation({ author_association: 'OWNER' }), 'OWNER');
  assert.equal(getCommentAuthorAssociation({ authorAssociation: 'MEMBER' }), 'MEMBER');
  assert.equal(isTrustedCommentAuthor({ authorAssociation: 'COLLABORATOR' }), true);
});

test('RESTフィールドが存在する場合はcamelCase側の値へフォールバックしない', () => {
  assert.equal(isTrustedCommentAuthor({ author_association: 'NONE', authorAssociation: 'OWNER' }), false);
});
