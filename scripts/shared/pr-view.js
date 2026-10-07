'use strict';
// pr-view.js — gh pr view応答の共有パーサーとHEAD取得

const { spawnSync } = require('./child-process');

const GH_TIMEOUT_MS = 30000;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

function parsePrViewResponse(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout || '');
  } catch (err) {
    return { ok: false, error: `PR情報のJSONパースに失敗しました: ${err.message}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'PR情報のJSON形式が不正です' };
  }

  if (parsed.comments !== undefined && !Array.isArray(parsed.comments)) {
    return { ok: false, error: 'PR情報のcommentsフィールドが配列ではありません' };
  }

  if (parsed.headRefOid !== undefined && parsed.headRefOid !== null
      && typeof parsed.headRefOid !== 'string') {
    return { ok: false, error: 'PR情報のheadRefOidフィールドが文字列ではありません' };
  }

  let prAuthor;
  if (parsed.author !== undefined && parsed.author !== null) {
    if (typeof parsed.author !== 'object' || Array.isArray(parsed.author)) {
      return { ok: false, error: 'PR情報のauthorフィールドが不正です' };
    }
    if (parsed.author.login !== undefined && typeof parsed.author.login !== 'string') {
      return { ok: false, error: 'PR情報のauthor.loginフィールドが文字列ではありません' };
    }
    prAuthor = parsed.author.login;
  }

  return {
    ok: true,
    comments: parsed.comments || [],
    headSha: parsed.headRefOid || '',
    prAuthor,
  };
}

function parsePrHeadResponse(stdout) {
  const parsed = parsePrViewResponse(stdout);
  if (!parsed.ok) return parsed;
  if (!SHA_RE.test(parsed.headSha)) {
    return { ok: false, error: 'PR情報に有効なheadRefOidがありません' };
  }
  return { ok: true, headSha: parsed.headSha };
}

function ghPrViewHead(pr, repo, opts = {}) {
  return spawnSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    ...opts,
  });
}

/**
 * PR HEADを取得する。失敗を空文字へ丸めず、呼び出し側が判別できる結果を返す。
 *
 * @param {string|number} pr
 * @param {string} repo
 * @param {{ghPrViewFn?:Function}} [deps]
 * @returns {{ok:true,headSha:string}|{ok:false,error:string}}
 */
function readPrHead(pr, repo, deps = {}) {
  const prNumber = String(pr === undefined || pr === null ? '' : pr).trim();
  if (!/^\d+$/.test(prNumber) || Number(prNumber) <= 0) {
    return { ok: false, error: `PR番号が不正です: ${pr}` };
  }
  const targetRepo = typeof repo === 'string' ? repo.trim() : '';
  if (!targetRepo) return { ok: false, error: 'リポジトリ名が空です' };

  const ghPrViewFn = deps.ghPrViewFn || ghPrViewHead;
  let result;
  try {
    result = ghPrViewFn(prNumber, targetRepo);
  } catch (error) {
    return {
      ok: false,
      error: `PR #${prNumber} のHEAD取得に失敗しました: ${error && error.message ? error.message : String(error)}`,
    };
  }
  if (!result || result.error || result.status !== 0) {
    return {
      ok: false,
      error: `PR #${prNumber} のHEAD取得に失敗しました: ${(result && result.error && result.error.message) || (result && result.stderr) || '(no stderr)'}`,
    };
  }
  return parsePrHeadResponse(result.stdout);
}

module.exports = {
  GH_TIMEOUT_MS,
  SHA_RE,
  parsePrViewResponse,
  parsePrHeadResponse,
  ghPrViewHead,
  readPrHead,
};
