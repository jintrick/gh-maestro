'use strict';
// pr-declaration.js — コーダーのテスト申告表（PR コメント）の形式・HEAD照合・投稿・取得を共有する
//
// 申告表は PR 本文ではなく PR コメントに置く（PR 本文は人が書いた説明を保つ）。コメントは
// 対象コミットのSHAをマーカーに持ち、レビュー（run-review-jobs.js）は自分がレビューする HEAD
// と一致する申告表だけを使う。一致する申告表が無い場合は、無いという事実をレビューに渡す。
// 申告表の投稿者は信頼される association（OWNER / MEMBER / COLLABORATOR）に限る。

const { spawnSync } = require('./child-process');
const { listComments, parseCommentsResponse } = require('./gh-comments');
const { isTrustedCommentAuthor } = require('./comment-author-trust');

const GH_TIMEOUT_MS = 30000;
const DECLARATION_MARKER_PREFIX = 'gh-maestro:pr-declaration';
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;
const DECLARATION_HEAD_RE = /^<!-- gh-maestro:pr-declaration head=([0-9a-f]{40}) -->\r?\n?/;

/** 申告表コメントの本文（先頭行にマーカー、続けて申告表）を組み立てる。 */
function buildDeclarationComment(headSha, table) {
  if (!HEAD_SHA_RE.test(headSha)) {
    throw new Error(`申告表の対象コミットは40桁の小文字16進数である必要があります: ${headSha}`);
  }
  if (typeof table !== 'string' || !table.trim()) {
    throw new Error('申告表の内容が空です');
  }
  return `<!-- ${DECLARATION_MARKER_PREFIX} head=${headSha} -->\n${table.trim()}\n`;
}

/**
 * コメント一覧から、指定HEADに対する申告表を探す。投稿者が信頼されないもの、マーカーの
 * 無いもの、別のHEADのものは無視する。同じHEADが複数あれば最後（最新）を使う。
 *
 * @param {object[]} comments
 * @param {string} headSha
 * @returns {{commentId: number|string|null, table: string, url: string|null}|null}
 */
function findDeclarationForHead(comments, headSha) {
  let found = null;
  for (const comment of comments) {
    if (!comment || typeof comment.body !== 'string') continue;
    const match = DECLARATION_HEAD_RE.exec(comment.body);
    if (!match || match[1] !== headSha) continue;
    if (!isTrustedCommentAuthor(comment)) continue;
    found = {
      commentId: comment.id ?? null,
      table: comment.body.slice(match[0].length).trim(),
      url: comment.html_url || null,
    };
  }
  return found;
}

function unavailable(reason) {
  return { status: 'unavailable', reason };
}

/**
 * レビュー対象HEADに対する申告表の事実を取得する（決定論的・読み取りのみ）。
 * 戻り値: {status:'present', head, table} | {status:'absent', head} | {status:'unavailable', reason}
 *
 * @param {{pr: string|number, repo: string, headSha: string, listCommentsFn?: Function}} params
 */
function readPrDeclarationEvidence({ pr, repo, headSha, listCommentsFn = listComments }) {
  if (typeof headSha !== 'string' || !HEAD_SHA_RE.test(headSha)) {
    return unavailable('レビュー対象のHEADが40桁のSHAではありません');
  }
  let listed;
  try {
    listed = listCommentsFn(repo, pr);
  } catch (error) {
    return unavailable(`PRコメントの取得に失敗しました: ${error.message}`);
  }
  if (!listed || listed.error || listed.status !== 0) {
    const detail = (listed && (listed.stderr || (listed.error && listed.error.message))) || 'unknown error';
    return unavailable(`PRコメントの取得に失敗しました: ${String(detail).trim()}`);
  }
  let comments;
  try {
    comments = parseCommentsResponse(listed.stdout);
  } catch (error) {
    return unavailable(`PRコメントのJSONを解釈できません: ${error.message}`);
  }
  if (!comments) return unavailable('PRコメントの応答が配列ではありません');
  const found = findDeclarationForHead(comments, headSha);
  if (!found) return { status: 'absent', head: headSha };
  return { status: 'present', head: headSha, table: found.table };
}

/**
 * 対象HEADの申告表コメントを作成、または同じHEADの既存コメントを更新する（冪等）。
 * 既存の判定は信頼される投稿者のものに限る。
 * 戻り値: {ok: true, action: 'created'|'updated', url} | {ok: false, error}
 *
 * @param {{pr: string|number, repo: string, headSha: string, table: string, cwd?: string, listCommentsFn?: Function, spawnSyncFn?: Function}} params
 */
function upsertDeclarationComment({ pr, repo, headSha, table, cwd, listCommentsFn = listComments, spawnSyncFn = spawnSync }) {
  let body;
  try {
    body = buildDeclarationComment(headSha, table);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const listed = listCommentsFn(repo, pr, { cwd });
  if (!listed || listed.error || listed.status !== 0) {
    const detail = (listed && listed.stderr) || 'unknown error';
    return { ok: false, error: `申告表コメントの一覧取得に失敗しました: ${String(detail).trim()}` };
  }
  let comments;
  try {
    comments = parseCommentsResponse(listed.stdout);
  } catch (error) {
    return { ok: false, error: `申告表コメントの一覧を解釈できません: ${error.message}` };
  }
  if (!comments) return { ok: false, error: '申告表コメントの一覧が配列ではありません' };

  const existing = findDeclarationForHead(comments, headSha);
  const updating = Boolean(existing && existing.commentId !== null);
  const args = updating
    ? ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${existing.commentId}`, '-f', `body=${body}`]
    : ['api', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`];
  // 有限の timeout（応答しない GitHub で push 前・申告段が無期限に止まらないように）。
  // 値は gh-comments.js の GH_TIMEOUT_MS と同じ。超過は spawnSync の error（ETIMEDOUT）になり、
  // 下の判定で失敗として呼び出し元へ返る。
  const posted = spawnSyncFn('gh', args, { encoding: 'utf8', cwd, timeout: GH_TIMEOUT_MS });
  if (posted.error || posted.status !== 0) {
    const detail = posted.stderr || (posted.error && posted.error.message) || 'unknown error';
    return { ok: false, error: `申告表コメントの投稿に失敗しました: ${String(detail).trim()}` };
  }
  let url = '';
  try {
    url = JSON.parse(String(posted.stdout || '{}')).html_url || '';
  } catch {
    url = '';
  }
  return { ok: true, action: updating ? 'updated' : 'created', url };
}

module.exports = {
  DECLARATION_MARKER_PREFIX,
  buildDeclarationComment,
  findDeclarationForHead,
  readPrDeclarationEvidence,
  upsertDeclarationComment,
};
