'use strict';

// prior-findings.js — orchestratorが再レビュー時にReview Managerへ渡す「前回の指摘と
// その扱い」ファイルの読み込み・検証と、不完全レビューの公開経路での未変更指摘の除外。
//
// 形式は review-findings-schema.json（正本）に、各指摘の disposition
// （fixed / ignored / deferred）を足したもの。スキーマは正本から実行時に派生させ、
// 二重定義しない。内容はReview Managerにとって判定に使うデータであり命令ではない。
// 読み込めない・スキーマに合わない場合は例外を投げる（呼び出し側は起動を拒否する。fail-closed）。
//
// requireされるだけのモジュール（CLIエントリポイントなし）のため --help 対象外。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { readJsonFile } = require('./json-file');
const { _validateAgainstSchema } = require('./json-schema');
const { toWinPath } = require('./win-path');

const FINDINGS_SCHEMA_PATH = path.join(__dirname, '..', 'review-findings-schema.json');
const DISPOSITIONS = ['fixed', 'ignored', 'deferred'];
// 以降の再レビューで、該当箇所が未変更なら出し直さない扱い。
const SUPPRESSING_DISPOSITIONS = ['ignored', 'deferred'];

/** review-findings-schema.json を正本として、findings の各要素に disposition を足したスキーマを返す。 */
function buildPriorFindingsSchema() {
  const schema = JSON.parse(fs.readFileSync(FINDINGS_SCHEMA_PATH, 'utf8'));
  const items = schema.properties.findings.items;
  items.properties.disposition = { type: 'string', enum: DISPOSITIONS };
  items.required = [...items.required, 'disposition'];
  return schema;
}

/**
 * @param {string} filePath
 * @returns {object} 検証済みの前回の指摘ペイロード
 * @throws 読み取り不能・JSON構文エラー・スキーマ違反
 */
function loadPriorFindings(filePath) {
  const abs = path.resolve(toWinPath(filePath));
  const payload = readJsonFile(abs);
  const errors = _validateAgainstSchema(payload, buildPriorFindingsSchema());
  if (errors.length > 0) {
    throw new Error(`前回の指摘ファイルがスキーマに合いません (${abs}): ${errors.join('; ')}`);
  }
  return payload;
}

/** @returns {string} 検証済みファイルの絶対パス */
function assertValidPriorFindingsFile(filePath) {
  loadPriorFindings(filePath);
  return path.resolve(toWinPath(filePath));
}

function runGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 20 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

const normalizeAnchor = (s) => String(s).replace(/\r\n/g, '\n').trim();

/**
 * 前回HEADのファイルで line_anchor が占める行範囲（1始まり、両端含む）。見つからなければ null。
 */
function anchorLineRange(oldText, anchor) {
  const text = oldText.replace(/\r\n/g, '\n');
  const needle = normalizeAnchor(anchor);
  if (!needle) return null;
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  const start = text.slice(0, idx).split('\n').length;
  const end = start + needle.split('\n').length - 1;
  return { start, end };
}

/** `git diff -U0` の出力から、前回側（旧ファイル）の変更範囲を取り出す。 */
function oldSideHunks(diffText) {
  const hunks = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;
  let m;
  while ((m = re.exec(diffText)) !== null) {
    hunks.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return hunks;
}

/**
 * 前回HEAD→現在のHEADの差分で、line_anchor の範囲が変わっていないかを判定する。
 * 判定できないとき（git失敗・前回HEADにファイルや断片が無い）は「変わった」とみなす（出し直しを許す側）。
 */
function isAnchorUnchanged({ cwd, priorHead, filePath, anchor }) {
  if (!/^[0-9a-f]{7,64}$/i.test(priorHead)) return false;
  const oldText = runGit(cwd, ['show', `${priorHead}:${filePath}`]);
  if (oldText === null) return false;
  const range = anchorLineRange(oldText, anchor);
  if (!range) return false;
  const diff = runGit(cwd, ['diff', '-U0', priorHead, 'HEAD', '--', filePath]);
  if (diff === null) return false;
  for (const h of oldSideHunks(diff)) {
    if (h.count === 0) {
      // 行の挿入（旧ファイルの h.start 行の後ろ）。アンカーの内側に入るときだけ変更。
      if (h.start >= range.start && h.start < range.end) return false;
    } else if (h.start <= range.end && h.start + h.count - 1 >= range.start) {
      return false;
    }
  }
  return true;
}

/**
 * 前回「無視」「保留」と扱った指摘のうち、該当箇所（path と line_anchor）が前回HEADから
 * 変わっていないものを findings から除く。前回の指摘ファイルが読めないときは何も除かず、
 * 除けなかった事実を unavailable に返す（不完全レビューの通知そのものを止めないため）。
 *
 * @param {object[]} findings
 * @param {string|null} priorFindingsFile
 * @param {{cwd?: string}} [options] cwd は前回・現在のHEADを引けるgitワークツリー
 * @returns {{findings: object[], suppressedCount: number, unavailable: string|null}}
 */
function suppressUnchangedPriorFindings(findings, priorFindingsFile, options = {}) {
  if (!priorFindingsFile) return { findings, suppressedCount: 0, unavailable: null };
  let prior;
  try {
    prior = loadPriorFindings(priorFindingsFile);
  } catch (e) {
    return { findings, suppressedCount: 0, unavailable: e.message };
  }
  const cwd = options.cwd || process.cwd();
  const candidates = prior.findings.filter(p => SUPPRESSING_DISPOSITIONS.includes(p.disposition));
  const kept = [];
  let suppressedCount = 0;
  for (const f of findings) {
    const matched = candidates.some(p => p.path === f.path
      && normalizeAnchor(p.line_anchor) === normalizeAnchor(f.line_anchor || '')
      && isAnchorUnchanged({ cwd, priorHead: prior.headRefOid, filePath: p.path, anchor: p.line_anchor }));
    if (matched) suppressedCount++; else kept.push(f);
  }
  return { findings: kept, suppressedCount, unavailable: null };
}

module.exports = {
  assertValidPriorFindingsFile,
  loadPriorFindings,
  buildPriorFindingsSchema,
  suppressUnchangedPriorFindings,
  isAnchorUnchanged,
};
