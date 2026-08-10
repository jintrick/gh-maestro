'use strict';
// migration-marker.js — migrate-records.js の実行中を示すマーカーファイルの読み書き。
//
// このマーカーが存在する間、ensure-inbox-supervisor.js は inbox-supervisor の自動起動を
// 抑制する（Issue #256: 移行中にデーモンが自動復活し、移行先の空状態で記録を上書きしかける
// 事故の防止）。マーカーパスは migrate-records.js（作成側）と ensure-inbox-supervisor.js
// （抑制側）の両方が一致していなければならず、ズレると安全機構が黙って無効化されるため、
// パスはこの単一モジュールに集約する。
//
// 設置場所は <workspace>/.gh-maestro/ 配下（install.js 管理対象外）。workspace は
// resolveWorkspace() の解決結果を使う前提で、既存の `.gh-maestro/` ディレクトリ
// （workers.json / assistants.json / inbox-supervisor-autostart.log 等）と同じ扱い。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');

function migrationInProgressPath(workspace) {
  return path.resolve(workspace, '.gh-maestro', '.migration-in-progress');
}

function isMigrationInProgress(workspace) {
  return fs.existsSync(migrationInProgressPath(workspace));
}

function markMigrationInProgress(workspace) {
  const p = migrationInProgressPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '', 'utf8');
}

function clearMigrationInProgress(workspace) {
  try { fs.unlinkSync(migrationInProgressPath(workspace)); } catch {}
}

module.exports = {
  migrationInProgressPath,
  isMigrationInProgress,
  markMigrationInProgress,
  clearMigrationInProgress,
};
