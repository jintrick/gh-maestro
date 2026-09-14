'use strict';

// roleless-worker.js — roleなし旧worker名の判定を検出・整理経路で共有する。
//
// workers.json の skill/issue が読める場合は、実際に導出したroleをworker名と
// 比較する。旧形式の記録やleaseのようにその情報が無い場合だけ、台帳の名前形状へ
// フォールバックする。同じ判定を detector と cleanup の両方から使うことで、片方だけ
// が対象を見落とす、または現行workerを旧形式と誤認するずれを防ぐ。

const { deriveRoleFromSkill } = require('./worker-factory');

const DEFAULT_ROLELESS_WORKER_NAME_PATTERN = '^issue-\\d+-(?!coder-|senior-coder-|explorer-|diagnostician-|architect-|review-manager-|base-|assistant-)[A-Za-z0-9_-]+$';

function compilePattern(pattern) {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`roleless worker name の正規表現が不正です: ${error.message}`);
  }
}

/**
 * role/issueを持つ現行形式の記録から判定できる場合はbooleanを返し、
 * 判定材料が不足している場合はnullを返す。
 */
function rolelessFromWorkerEntry(name, entry) {
  if (entry && typeof entry === 'object' && Number.isFinite(Number(entry.issue))
    && typeof entry.skill === 'string') {
    try {
      const role = deriveRoleFromSkill(entry.skill);
      const issuePrefix = `issue-${Number(entry.issue)}-`;
      if (name.startsWith(issuePrefix)) return !name.startsWith(`${issuePrefix}${role}-`);
    } catch {
      // skillが旧形式・未知形式なら名前形状の判定へフォールバックする。
    }
  }
  return null;
}

/**
 * roleなし旧worker名を判定する。
 *
 * 第2引数に正規表現文字列を渡す旧呼び出しも受け付ける。これは既存の
 * spawn-worker.js の公開テスト補助APIとの互換を保つための入力アダプターであり、
 * 判定本体は常にこのutilityだけが持つ。
 */
function isRolelessWorkerName(name, entry, parameters = {}) {
  if (typeof name !== 'string') return false;
  if (typeof entry === 'string' && arguments.length < 3) {
    parameters = { namePattern: entry };
    entry = undefined;
  }
  const inferred = rolelessFromWorkerEntry(name, entry);
  if (inferred !== null) return inferred;
  const pattern = parameters && parameters.namePattern !== undefined
    ? parameters.namePattern
    : DEFAULT_ROLELESS_WORKER_NAME_PATTERN;
  return compilePattern(pattern).test(name);
}

module.exports = {
  DEFAULT_ROLELESS_WORKER_NAME_PATTERN,
  isRolelessWorkerName,
};
