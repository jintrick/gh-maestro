'use strict';
// collect-housekeeping-exclusions.js — sweep が workspace housekeeping から除外すべき
// 稼働中ワーカーを収集する。
//
// session 起動時の `process-lifecycle.js sweep` は、後段の housekeeping
// （workspace-housekeeping.js: ログ整理・一時ファイル削除）に「処理対象から除外する」
// ワーカー集合を渡す。この集合は 3 つの生存情報源から組み立てる:
//   - workers.json のエントリ（worker-liveness.js の生存述語）
//   - .gh-maestro/leases/*.json（worker-lease.js の live lease 判定）
//   - .gh-maestro/records/pr/<PR>/review/manager.running（Review Manager の PID 生存）
// PID registry（.gh-maestro/pids/）由来の生存ワーカーはここでは扱わない。sweepRegistry
// 自身が kill ループ内で確認した結果を呼び出し側で足し合わせる。
//
// process-lifecycle.js は CLI 主経路（require.main === module）では sweepRegistry →
// 本モジュールの順に require される。モジュール評価時に process-lifecycle を require して
// 捕捉すると module.exports 未確定の undefined を掴むため、process-lifecycle 由来の関数は
// 呼び出し時点で解決する（Issue #267）。その他の共有モジュール（workers-registry /
// worker-liveness / worker-lease / review-manager-paths）は process-lifecycle への循環
// require を持たないため評価時 require でよい。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const path = require('path');
const fs = require('fs');
const { readWorkersRaw } = require('./workers-registry');
const { isWorkerAlive } = require('./worker-liveness');
const { createNormalWorkerStore, isLeaseLive } = require('./worker-lease');
const { reviewArtifactPath } = require('./review-manager-paths');

// process-lifecycle 由来の関数のみ呼び出し時点で解決する（循環 require 対策、上記参照）。
// テスト注入（_setIsProcessAlive）は注入値が優先される。
let _injectedIsProcessAlive = null;
function _isProcessAlive(pid) {
  const fn = _injectedIsProcessAlive ?? require('../process-lifecycle').isProcessAlive;
  return fn(pid);
}

/**
 * housekeeping から除外する稼働中ワーカーを収集する。
 *
 * ディレクトリ欠落（新規ワークスペース等）は空集合として扱う。一方、例外の伝播は
 * フェイルクローズの入口であり、sweepRegistry 側で掃除を中断させる（組み立て不能のまま
 * 稼働中ワーカーのログを整理しない。Issue #267）。個々のレコードが壊れている場合は
 * 各情報源の読み取り側（store.read / readWorkersRaw 等）が null に潰して無害化する。
 *
 * @param {string} workspace ワークスペース絶対パス
 * @returns {{ workerNames: Set<string>, reviewPrs: Set<string> }}
 *   除外対象のワーカー名（通常 headless ワーカー）と Review Manager 対象 PR 番号
 */
function collectHousekeepingExclusions(workspace) {
  const workerNames = new Set();
  const reviewPrs = new Set();
  const ghDir = path.join(workspace, '.gh-maestro');

  // PID registry にない通常 headless ワーカーも、既存の workers.json の生存述語を
  // 再利用して除外対象へ加える。
  const rawWorkers = readWorkersRaw(workspace);
  if (rawWorkers) {
    for (const [workerName, entry] of Object.entries(rawWorkers)) {
      if (workerName !== 'orchestrator' && isWorkerAlive(entry)) workerNames.add(workerName);
    }
  }

  // lease が live のワーカーも除外対象へ加える。
  const leasesDir = path.join(ghDir, 'leases');
  if (fs.existsSync(leasesDir)) {
    const store = createNormalWorkerStore(workspace);
    for (const name of fs.readdirSync(leasesDir).filter(n => n.endsWith('.json'))) {
      const workerName = name.slice(0, -5);
      const entry = store.read(workerName);
      if (isLeaseLive(entry)) workerNames.add(entry.workerName || workerName);
    }
  }

  // 通常ワーカー以外の Review Manager は PID registry に登録されず、専用の
  // review manager の .running lease だけを持つ。既存の lease 契約（PID 生存）を
  // 再利用して、対応する records/pr/<PR>/review/manager.log を保護する。
  const prDir = path.join(ghDir, 'records', 'pr');
  if (fs.existsSync(prDir)) {
    for (const entry of fs.readdirSync(prDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const runningPath = reviewArtifactPath(ghDir, entry.name, '.running');
      let pid;
      try { pid = Number(fs.readFileSync(runningPath, 'utf8').trim()); } catch { continue; }
      if (Number.isInteger(pid) && pid > 0 && _isProcessAlive(pid)) reviewPrs.add(entry.name);
    }
  }

  return { workerNames, reviewPrs };
}

module.exports = {
  collectHousekeepingExclusions,
  // テスト用注入（test-process-spawn-safety ルール準拠。実プロセス確認を回避する）
  _setIsProcessAlive: (fn) => { _injectedIsProcessAlive = fn; },
};
