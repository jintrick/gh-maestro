'use strict';

// テスト申告コメントの形式・信頼性・HEAD照合を共有する純粋関数群。
// poll-reviews.js の内部状態ファイルを正本にせず、現在のPRコメントを読む経路でも
// 同じルールを使えるようにする。

const TEST_RESULT_MARKER = '<!-- gh-maestro-test-result:v1 -->';
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * 申告コメントから対象コミットSHAとfail/pass数を抽出する純粋関数。
 * @param {string} body コメント本文
 * @returns {{ commit: string, fail: number, pass?: number } | null}
 */
function extractTestDeclaration(body) {
  if (!body || typeof body !== 'string' || !body.includes(TEST_RESULT_MARKER)) {
    return null;
  }
  const commitMatch = body.match(/-\s+\*\*対象コミット\*\*:\s*`([0-9a-fA-F]+)`/);
  if (!commitMatch) return null;
  const commit = commitMatch[1];

  const failMatch = body.match(/fail:\s*(\d+)/);
  if (!failMatch) return null;
  const fail = parseInt(failMatch[1], 10);

  const passMatch = body.match(/pass:\s*(\d+)/);
  const pass = passMatch ? parseInt(passMatch[1], 10) : undefined;

  return { commit, fail, pass };
}

/**
 * テスト申告の事実とPRのheadShaを突き合わせてステータスを判定する純粋関数。
 *
 * 判定ルール:
 * - declaration なし → NONE
 * - headSha が空/未定義（PRのHEAD SHAが照合不能） → NONE
 * - SHAが一致しない（headShaと異なるコミットに対して実行された結果） → STALE
 * - SHAが一致し、fail === 0 → GREEN
 * - SHAが一致し、fail > 0 → RED
 *
 * @param {{ commit: string, fail: number, pass?: number } | null} declaration
 * @param {string} headSha PRの現在のHEADコミットSHA
 * @returns {{ status: 'GREEN' | 'RED' | 'STALE' | 'NONE', declaredSha?: string, headSha?: string, fail?: number, pass?: number }}
 */
function evaluateTestDeclaration(declaration, headSha) {
  if (!declaration) {
    return { status: 'NONE', headSha: headSha || undefined };
  }
  const declSha = declaration.commit;
  const cleanHeadSha = typeof headSha === 'string' ? headSha.trim() : '';

  // headSha が空の場合は照合不能のため STALE ではなく NONE として扱う
  if (!cleanHeadSha) {
    return {
      status: 'NONE',
      declaredSha: declSha,
      headSha: undefined,
      fail: declaration.fail,
      pass: declaration.pass,
    };
  }

  // full SHA vs short SHA のプレフィックス一致、または完全一致を判定
  const isMatch = declSha && (
    cleanHeadSha === declSha ||
    cleanHeadSha.startsWith(declSha) ||
    declSha.startsWith(cleanHeadSha)
  );

  if (!isMatch) {
    return {
      status: 'STALE',
      declaredSha: declSha,
      headSha: cleanHeadSha,
      fail: declaration.fail,
      pass: declaration.pass,
    };
  }

  if (declaration.fail === 0) {
    return {
      status: 'GREEN',
      declaredSha: declSha,
      headSha: cleanHeadSha,
      fail: declaration.fail,
      pass: declaration.pass,
    };
  }

  return {
    status: 'RED',
    declaredSha: declSha,
    headSha: cleanHeadSha,
    fail: declaration.fail,
    pass: declaration.pass,
  };
}

/**
 * PR作成者または権限保持者による最新の有効な申告を選択する純粋関数。
 * 第三者が投稿した同じマーカーのコメントはテスト結果の正本として採用しない。
 *
 * @param {Array<object>} commentsList PRコメント一覧（古い順）
 * @param {string} prAuthor PR作成者のログイン名
 * @returns {{ commit: string, fail: number, pass?: number } | null}
 */
function findLatestTrustedTestDeclaration(commentsList, prAuthor) {
  if (!Array.isArray(commentsList)) return null;

  for (let i = commentsList.length - 1; i >= 0; i--) {
    const comment = commentsList[i];
    if (!comment || typeof comment !== 'object') continue;

    const commentAuthor = comment.author && comment.author.login;
    const isPrAuthor = prAuthor && commentAuthor && commentAuthor === prAuthor;
    const isPrivileged = typeof comment.authorAssociation === 'string'
      && TRUSTED_ASSOCIATIONS.has(comment.authorAssociation);
    if (!isPrAuthor && !isPrivileged) continue;

    const declaration = extractTestDeclaration(comment.body);
    if (declaration) return declaration;
  }

  return null;
}

module.exports = {
  TEST_RESULT_MARKER,
  TRUSTED_ASSOCIATIONS,
  extractTestDeclaration,
  evaluateTestDeclaration,
  findLatestTrustedTestDeclaration,
};
