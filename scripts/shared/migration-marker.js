'use strict';
// migration-marker.js — migrate-records.js の実行中を示すマーカーファイルの読み書き。
//
// このマーカーが存在する間、ensure-worker-supervisor.js は worker-supervisor の自動起動を
// 抑制する（Issue #256: 移行中にデーモンが自動復活し、移行先の空状態で記録を上書きしかける
// 事故の防止）。マーカーパスは migrate-records.js（作成側）と ensure-worker-supervisor.js
// （抑制側）の両方が一致していなければならず、ズレると安全機構が黙って無効化されるため、
// パスはこの単一モジュールに集約する。
//
// 設置場所は <workspace>/.gh-maestro/ 配下（install.js 管理対象外）。workspace は
// resolveWorkspace() の解決結果を使う前提で、既存の `.gh-maestro/` ディレクトリ
// （workers.json / worker-supervisor-autostart.log 等）と同じ扱い。
//
// マーカーは移行プロセスの識別子を保持する。死亡が確定した場合だけ
// 自動起動を再開し、照会不能なら移行中として自動起動を抑止する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');

const defaultLiveness = require('./process-liveness');
let injectedLiveness = null;
function liveness() { return injectedLiveness || defaultLiveness; }

function migrationInProgressPath(workspace) {
  return path.resolve(workspace, '.gh-maestro', '.migration-in-progress');
}

/**
 * マーカーが「有効な移行実行中」を示すかを判定する。
 *
 * 所有者の死亡が確定した場合は false。生存または照会不能なら true として
 * 自動起動を抑止する。読み取り・パース失敗はエラーとして報告する。
 *
 * @param {string} workspace
 * @returns {boolean}
 */
function isMigrationInProgress(workspace) {
  const p = migrationInProgressPath(workspace);
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error(`移行マーカー ${p} の読み取りに失敗しました: ${error.message}`, { cause: error });
  }
  let entry;
  try { entry = JSON.parse(raw); }
  catch (error) { throw new Error(`移行マーカー ${p} が不正です: ${error.message}`, { cause: error }); }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`移行マーカー ${p} はオブジェクトではありません`);
  }
  const checker = liveness();
  const state = checker.observe(checker.readRef(entry));
  // A failed observation cannot prove that migration has ended.
  return state !== 'dead';
}

function markMigrationInProgress(workspace) {
  const p = migrationInProgressPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const checker = liveness();
  const entry = checker.writeRef({}, checker.captureSelf());
  fs.writeFileSync(p, JSON.stringify(entry, null, 2), 'utf8');
}

function clearMigrationInProgress(workspace) {
  try { fs.unlinkSync(migrationInProgressPath(workspace)); } catch {}
}

module.exports = {
  migrationInProgressPath,
  isMigrationInProgress,
  markMigrationInProgress,
  clearMigrationInProgress,
  _setLiveness: (value) => { injectedLiveness = value; },
};
