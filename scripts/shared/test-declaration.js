'use strict';

// テスト申告コメントの形式・信頼性・HEAD照合を共有する純粋関数群。
// poll-reviews.js と query-test-status.js が同じ v1/v2 解釈を使い、申告入口が生成した
// provenance/scope を失わずに扱えるようにする。

const TEST_RESULT_MARKER = '<!-- gh-maestro-test-result:v2 -->';
const LEGACY_TEST_RESULT_MARKER = '<!-- gh-maestro-test-result:v1 -->';
const {
  TRUSTED_ASSOCIATIONS,
  isTrustedCommentAuthor,
} = require('./comment-author-trust');

const KNOWN_PROVENANCE = 'test-runner';
const FULL_SCOPE = 'full';
const PARTIAL_SCOPE = 'partial';

function matchCommit(body) {
  const match = body.match(/-\s+\*\*対象コミット\*\*:\s*`([0-9a-fA-F]{7,40})`/);
  return match ? match[1] : null;
}

function matchCount(body, name) {
  // v2 の実行件数は Markdown の太字ラベル（`実行件数**:`）で出力される一方、
  // fail/pass は結果欄の素のテキスト。両方の形式を同じ抽出関数で扱う。
  const match = body.match(new RegExp(`${name}(?:\\*\\*)?:\\s*` + '`?' + `([0-9]+)` + '`?'));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function matchBacktickField(body, label) {
  const match = body.match(new RegExp(
    '-\\s+\\*\\*' + label + '\\*\\*:\\s*`([^`]+)`'
  ));
  return match ? match[1].trim() : undefined;
}

/**
 * 申告コメント本文に v1/v2 のマーカーがあるかを判定する。
 * @param {unknown} body
 * @returns {boolean}
 */
function hasTestDeclarationMarker(body) {
  return typeof body === 'string'
    && (body.includes(TEST_RESULT_MARKER) || body.includes(LEGACY_TEST_RESULT_MARKER));
}

function extractV2Declaration(body) {
  const commit = matchCommit(body);
  if (!commit) return null;

  const resultMatch = body.match(/-\s+\*\*結果\*\*:\s*(pass|fail|unknown)\b/i);
  if (!resultMatch) return null;

  const provenance = matchBacktickField(body, '実行元');
  const scope = matchBacktickField(body, '実行範囲');
  const fail = matchCount(body, 'fail');
  const pass = matchCount(body, 'pass');
  const tests = matchCount(body, '実行件数');
  const resultLabel = resultMatch[1].toLowerCase();

  // known として扱うのは、ランナー由来・範囲既知・両カウント既知・結果ラベル整合の
  // 全条件を満たす v2 だけ。不完全な v2 は、数字が残っていても手入力の結果と同じく
  // unknown に縮退させ、full 実行と同じ見え方にしない。
  const isKnown = provenance === KNOWN_PROVENANCE
    && (scope === FULL_SCOPE || scope === PARTIAL_SCOPE)
    && fail !== undefined
    && pass !== undefined
    && resultLabel === (fail === 0 ? 'pass' : 'fail');

  if (!isKnown) {
    return {
      version: 2,
      commit,
      provenance: 'unknown',
      scope: 'unknown',
      fail: undefined,
      pass: undefined,
    };
  }

  return {
    version: 2,
    commit,
    provenance,
    scope,
    fail,
    pass,
    tests,
  };
}

function extractV1Declaration(body) {
  const commit = matchCommit(body);
  if (!commit) return null;
  const fail = matchCount(body, 'fail');
  if (fail === undefined) return null;
  return {
    version: 1,
    commit,
    fail,
    pass: matchCount(body, 'pass'),
    provenance: 'unknown',
    scope: 'unknown',
  };
}

/**
 * 申告コメントから対象コミット、結果、実行元、実行範囲を抽出する純粋関数。
 * v1 は値を読めても実行記録を持たないため provenance/scope を unknown とする。
 *
 * @param {string} body コメント本文
 * @returns {{version:number, commit:string, fail?:number, pass?:number, tests?:number, provenance:string, scope:string}|null}
 */
function extractTestDeclaration(body) {
  if (!hasTestDeclarationMarker(body)) return null;
  if (body.includes(TEST_RESULT_MARKER)) return extractV2Declaration(body);
  return extractV1Declaration(body);
}

function cleanHeadSha(headSha) {
  return typeof headSha === 'string' ? headSha.trim() : '';
}

function declarationMetadata(declaration) {
  return {
    provenance: declaration && typeof declaration.provenance === 'string'
      ? declaration.provenance : 'unknown',
    scope: declaration && typeof declaration.scope === 'string'
      ? declaration.scope : 'unknown',
  };
}

function declarationCounts(declaration) {
  const counts = {};
  if (declaration && Number.isSafeInteger(declaration.fail)) counts.fail = declaration.fail;
  if (declaration && Number.isSafeInteger(declaration.pass)) counts.pass = declaration.pass;
  return counts;
}

/**
 * テスト申告の事実とPRのheadShaを突き合わせてステータスを判定する純粋関数。
 * provenance/scope はステータスとは独立した事実として常に返す。したがって、旧 v1 の
 * fail=0 は GREEN でも scope=unknown となり、v2 full の GREEN と区別できる。
 *
 * @param {{commit:string, fail?:number, pass?:number, provenance?:string, scope?:string}|null} declaration
 * @param {string} headSha PRの現在のHEADコミットSHA
 * @returns {{status:'GREEN'|'RED'|'STALE'|'NONE', declaredSha?:string, headSha?:string, fail?:number, pass?:number, provenance:string, scope:string}}
 */
function evaluateTestDeclaration(declaration, headSha) {
  const cleanHead = cleanHeadSha(headSha);
  if (!declaration) {
    return {
      status: 'NONE',
      headSha: cleanHead || undefined,
      provenance: 'none',
      scope: 'none',
    };
  }

  const metadata = declarationMetadata(declaration);
  const counts = declarationCounts(declaration);
  const result = {
    declaredSha: declaration.commit,
    headSha: cleanHead || undefined,
    ...counts,
    ...metadata,
  };

  // headSha が空の場合は照合不能のため STALE ではなく NONE として扱う。
  if (!cleanHead) return { status: 'NONE', ...result };

  const declaredSha = typeof declaration.commit === 'string' ? declaration.commit : '';
  const isMatch = declaredSha && (
    cleanHead.toLowerCase() === declaredSha.toLowerCase()
    || cleanHead.toLowerCase().startsWith(declaredSha.toLowerCase())
    || declaredSha.toLowerCase().startsWith(cleanHead.toLowerCase())
  );

  if (!isMatch) return { status: 'STALE', ...result };
  if (!Number.isSafeInteger(declaration.fail)) return { status: 'NONE', ...result };
  return { status: declaration.fail === 0 ? 'GREEN' : 'RED', ...result };
}

/**
 * PR作成者または権限保持者による最新の有効な申告を選択する純粋関数。
 * 第三者が投稿した同じマーカーのコメントはテスト結果の正本として採用しない。
 *
 * @param {Array<object>} commentsList PRコメント一覧（古い順）
 * @param {string} prAuthor PR作成者のログイン名
 * @returns {object|null}
 */
function findLatestTrustedTestDeclaration(commentsList, prAuthor) {
  if (!Array.isArray(commentsList)) return null;

  for (let i = commentsList.length - 1; i >= 0; i--) {
    const comment = commentsList[i];
    if (!comment || typeof comment !== 'object') continue;

    const commentAuthor = comment.author && comment.author.login;
    const isPrAuthor = prAuthor && commentAuthor && commentAuthor === prAuthor;
    const isPrivileged = isTrustedCommentAuthor(comment);
    if (!isPrAuthor && !isPrivileged) continue;

    const declaration = extractTestDeclaration(comment.body);
    if (declaration) return declaration;
  }

  return null;
}

module.exports = {
  TEST_RESULT_MARKER,
  LEGACY_TEST_RESULT_MARKER,
  TRUSTED_ASSOCIATIONS,
  hasTestDeclarationMarker,
  extractTestDeclaration,
  evaluateTestDeclaration,
  findLatestTrustedTestDeclaration,
};
