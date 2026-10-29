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
const { createNormalWorkerStore } = require('./worker-lease');
const { listRunningReviewManagers } = require('./running-review-managers');
const { normalizePid } = require('./worker-entry');

const processLiveness = require('./process-liveness');
let injectedLiveness = null;

/**
 * housekeeping から除外する稼働中ワーカーを収集する。
 *
 * ディレクトリ欠落（新規ワークスペース等）は空集合として扱う。一方、例外の伝播は
 * フェイルクローズの入口であり、sweepRegistry 側で掃除を中断させる（組み立て不能のまま
 * 稼働中ワーカーのログを整理しない。Issue #267）。
 *
 * 「ファイルが存在するのに読み取り・解析できない」状態は「ファイル不在」と同じ扱いに
 * しない。不在＝正常な空状態だが、存在するのに読めない・parseできない・型不正は
 * 「そのワーカーの生存が判定できない」ことであり、黙って除外漏れにすると稼働中ワーカーの
 * ログを整理・ローテーションしかねない。workers.json（レジストリ全体）は readWorkersRaw が
 * 不在のみ null・それ以外は throw するため、本モジュールは例外をそのまま伝播させるだけで
 * よい（Issue #275 項目1）。lease と Review Manager の manager.running は本モジュール側で
 * 不在との区別を行う（PR #268 レビュー指摘）。PID registry（.gh-maestro/pids/）は
 * sweepRegistry 側が破損エントリを results.cleaned として能動的に検出・削除する既存契約が
 * あり、取り違えはない。
 *
 * @param {string} workspace ワークスペース絶対パス
 * @param {object} [opts]
 * @param {boolean} [opts.cleanupStale=true] staleなmanager.runningを回収するか
 * @returns {{ workerNames: Set<string>, reviewPrs: Set<string>, pids: Set<number> }}
 *   除外対象のワーカー名（通常 headless ワーカー）、Review Manager 対象 PR 番号、および稼働中プロセスの PID
 * @throws {Error} いずれかの情報源が「存在するのに読み取り・解析不能」の場合
 */
function collectHousekeepingExclusions(workspace, opts = {}) {
  const workerNames = new Set();
  const reviewPrs = new Set();
  const pids = new Set();
  const ghDir = path.join(workspace, '.gh-maestro');
  const checker = opts.liveness || injectedLiveness || processLiveness;
  const live = (entry, description, source) => {
    const state = checker.observe(checker.readRef(entry, 'default', { source }));
    if (state === 'unknown') throw new Error(`${description} の生死を判定できません`);
    return state === 'alive';
  };

  // PID registry にない通常 headless ワーカーも、既存の workers.json の生存述語を
  // 再利用して除外対象へ加える。
  // readWorkersRaw は「ファイル不在」のみ null で、存在するのに読み取り・parse・型不正は
  // throw する（Issue #275 項目1）。不在は空集合でよい。存在するのに解析不能は生存判定
  // 不能であり、黙って除外漏れにすると稼働中ワーカーのログを整理・ローテーションしかねない
  // ため、例外をそのまま伝播させて fail-closed にする（PR #268 レビュー指摘）。
  const rawWorkers = readWorkersRaw(workspace);
  if (rawWorkers) {
    for (const [workerName, entry] of Object.entries(rawWorkers)) {
      if (workerName !== 'orchestrator' && live(entry, `worker ${workerName}`, `${path.join(ghDir, 'workers.json')}#${workerName}`)) {
        workerNames.add(workerName);
        const normPid = normalizePid(entry && typeof entry === 'object' ? entry.pid : null);
        if (normPid) pids.add(normPid);
      }
    }
  }

  // lease が live のワーカーも除外対象へ加える。
  const leasesDir = path.join(ghDir, 'leases');
  if (fs.existsSync(leasesDir)) {
    const store = createNormalWorkerStore(workspace);
    for (const name of fs.readdirSync(leasesDir).filter(n => n.endsWith('.json'))) {
      const workerName = name.slice(0, -5);
      const entry = store.read(workerName);
      // store.read は「不在」と「破損・解析不能」の両方で null を返す。このループは
      // readdirSync で存在を確認した直後のため、null かつファイルが残っているのは
      // 読み取り不能・解析不能を意味する（列挙直後に消えた = ワーカー終了による lease
      // 解放は skip でよい）。破損 lease の生存判定は不能であり、黙って除外漏れにすると
      // 稼働中ワーカーのログを整理しかねない（PR #268 レビュー指摘）。fail-closed で伝播。
      if (entry === null && fs.existsSync(path.join(leasesDir, name))) {
        throw new Error(`lease の読み取り・解析に失敗しました: ${path.join(leasesDir, name)}`);
      }
      if (entry && live(entry, `lease ${path.join(leasesDir, name)}`, path.join(leasesDir, name))) {
        workerNames.add(entry.workerName || workerName);
        const normPid = normalizePid(entry.pid);
        if (normPid) pids.add(normPid);
      }
    }
  }

  // 通常ワーカー以外の Review Manager は PID registry に登録されず、専用の
  // manager.running だけを持つ。新形式は OS endpoint と instanceId の同一性まで確認して、
  // 対応する records/pr/<PR>/review/manager.log を保護する。
  //
  // 旧形式の生存PIDは同一性を確認できないので live 一覧には入れない。ただし
  // アップグレード直後に旧RMがまだ動いている間だけは、当該PRの成果物を掃除から
  // 守る必要がある。onLegacyLive はその保護集合だけを更新し、例外を投げずに次のPRへ
  // 進めるための経路である。旧PIDを pids 集合へ入れることはしない。
  const runningManagers = listRunningReviewManagers(workspace, {
    liveness: checker,
    onError: 'throw',
    cleanupStale: opts.cleanupStale !== false,
  });
  for (const manager of runningManagers) {
    reviewPrs.add(manager.pr);
  }

  return { workerNames, reviewPrs, pids };
}

module.exports = {
  collectHousekeepingExclusions,
  // テスト用注入（実プロセス確認を回避する）
  _setLiveness: (value) => { injectedLiveness = value; },
};
