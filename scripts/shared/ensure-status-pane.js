'use strict';
// ensure-status-pane.js — ワークスペースの監視ペインを冪等に存在保証する。
//
// worker-status.js の手動 pane 経路と、spawn-worker.js / msg-send.js の自動保証経路が
// 同じ status-pane.json を扱う。確認から split-pane 起動・記録更新までを
// process-lifecycle.js の専用 startup lock で囲み、同一ワークスペースの並行呼び出しが
// 監視ペインを二重作成しないようにする。
//
// WezTerm は任意の実行環境に存在しないため、このモジュールは運用上の失敗を例外にせず
// 構造化された失敗結果へ変換する。呼び出し側は worker の起動・メッセージ送信を継続できる。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const path = require('path');

const STATUS_PANE_LOCK_SCRIPT = 'status-pane';
const STATUS_PANE_LOCK_WORKER = null;
const DEFAULT_INTERVAL_SEC = 3;
const DEFAULT_DIRECTION = 'bottom';
const DEFAULT_PERCENT = 15;

function defaultLoadStatusPane(workspace) {
  return require('./status-pane-registry').loadStatusPane(workspace);
}

function defaultSaveStatusPane(workspace, entry) {
  return require('./status-pane-registry').saveStatusPane(workspace, entry);
}

function defaultIsPaneAlive(paneId) {
  const alivePanes = require('./pane-launch').getAlivePaneIds();
  if (alivePanes === null) {
    // `isPaneAlive()` は既存の close-pane 契約として照会不能を false に縮退するが、
    // ここで false と解釈して split-pane を続けると、一覧取得の一時失敗時に重複作成する。
    // 存在保証では照会不能を明示的な失敗として扱い、危険な起動へ進まない。
    throw new Error('WezTermのpane一覧を取得できませんでした');
  }
  return alivePanes.has(String(paneId));
}

function defaultLaunchInSplitPane(params) {
  return require('./pane-launch').launchInSplitPane(params);
}

function defaultAcquireLock(workspace) {
  return require('../process-lifecycle').acquireStartupLock(
    workspace,
    STATUS_PANE_LOCK_SCRIPT,
    STATUS_PANE_LOCK_WORKER,
  );
}

function defaultReleaseLock(workspace) {
  return require('../process-lifecycle').releaseStartupLock(
    workspace,
    STATUS_PANE_LOCK_SCRIPT,
    STATUS_PANE_LOCK_WORKER,
  );
}

function failure(stage, error) {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  return { ok: false, stage, error: message };
}

function validPaneId(paneId) {
  return paneId !== null && paneId !== undefined && String(paneId) !== '';
}

/**
 * 監視ペインの存在を保証する。
 *
 * @param {object} params
 * @param {string} params.workspace ワークスペース絶対パス
 * @param {string} params.scriptsPath worker-status.js が置かれたディレクトリ
 * @param {number} [params.interval=3] watch の更新間隔
 * @param {string} [params.direction='bottom'] ペインの分割方向
 * @param {number} [params.percent=15] ペインの画面占有率
 * @param {object} [deps] テスト用依存注入
 * @param {Function} [deps.loadStatusPaneFn]
 * @param {Function} [deps.saveStatusPaneFn]
 * @param {Function} [deps.isPaneAliveFn]
 * @param {Function} [deps.launchInSplitPaneFn]
 * @param {Function} [deps.acquireLockFn] `(workspace) => boolean`
 * @param {Function} [deps.releaseLockFn] `(workspace) => void`
 * @param {Function} [deps.nowFn]
 * @returns {{ok:true,paneId:string,reused:boolean}|{ok:false,stage:string,error:string}}
 */
function ensureStatusPane(params = {}, deps = {}) {
  const workspace = params.workspace;
  const scriptsPath = params.scriptsPath;
  if (typeof workspace !== 'string' || !workspace || typeof scriptsPath !== 'string' || !scriptsPath) {
    return failure('input', 'workspace と scriptsPath は必須です');
  }

  const interval = params.interval ?? DEFAULT_INTERVAL_SEC;
  const direction = params.direction ?? DEFAULT_DIRECTION;
  const percent = params.percent ?? DEFAULT_PERCENT;
  const loadStatusPaneFn = deps.loadStatusPaneFn || defaultLoadStatusPane;
  const saveStatusPaneFn = deps.saveStatusPaneFn || defaultSaveStatusPane;
  const isPaneAliveFn = deps.isPaneAliveFn || defaultIsPaneAlive;
  const launchInSplitPaneFn = deps.launchInSplitPaneFn || defaultLaunchInSplitPane;
  const acquireLockFn = deps.acquireLockFn || defaultAcquireLock;
  const releaseLockFn = deps.releaseLockFn || defaultReleaseLock;
  const nowFn = deps.nowFn || Date.now;

  let locked = false;
  try {
    try {
      locked = Boolean(acquireLockFn(workspace));
    } catch (error) {
      return failure('lock', error);
    }
    if (!locked) {
      return failure('lock', '監視ペインの保証ロックを取得できませんでした');
    }

    let existingPane;
    try {
      existingPane = loadStatusPaneFn(workspace);
    } catch (error) {
      return failure('load', error);
    }

    if (existingPane && validPaneId(existingPane.paneId)) {
      let alive;
      try {
        alive = Boolean(isPaneAliveFn(existingPane.paneId));
      } catch (error) {
        return failure('lookup', error);
      }
      if (alive) {
        return { ok: true, paneId: String(existingPane.paneId), reused: true };
      }
    }

    let paneResult;
    try {
      paneResult = launchInSplitPaneFn({
        argv: [
          process.execPath,
          path.join(scriptsPath, 'worker-status.js'),
          'watch',
          '--workspace', workspace,
          '--interval', String(interval),
        ],
        cwd: workspace,
        direction,
        percent,
      });
    } catch (error) {
      return failure('launch', error);
    }

    if (!paneResult || !validPaneId(paneResult.paneId)) {
      return failure('launch', 'split-pane の結果から pane-id を取得できませんでした');
    }

    const paneId = String(paneResult.paneId);
    let launchedAt;
    try {
      launchedAt = new Date(nowFn()).toISOString();
    } catch (error) {
      return failure('save', error);
    }

    try {
      saveStatusPaneFn(workspace, { paneId, launchedAt });
    } catch (error) {
      return failure('save', error);
    }

    return { ok: true, paneId, reused: false };
  } catch (error) {
    return failure('unknown', error);
  } finally {
    if (locked) {
      // process-lifecycle.js の releaseStartupLock は自PIDのロックだけを解放し、通常は
      // 例外を投げない。解放時の一時的なI/O失敗で本来の起動結果を覆さないため、
      // 呼び出し元の処理は継続する。
      try { releaseLockFn(workspace); } catch {}
    }
  }
}

module.exports = {
  ensureStatusPane,
  STATUS_PANE_LOCK_SCRIPT,
  STATUS_PANE_LOCK_WORKER,
};
