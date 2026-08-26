#!/usr/bin/env node
// worker-status.js — ワーカーの稼働状況・連続稼働時間の確認
//
// workers.json の指定エントリまたは全エントリを照会し、
// ワーカーの生死および実起動時刻に基づく連続稼働時間を返す。
// 一覧（list）では横棒グラフ（または --json）を出力し、
// 常駐表示（watch / pane）では画面クリア・WezTermスプリットペインで自動更新する。

'use strict';

const { normalizeWorkerEntry } = require('./shared/worker-entry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const { readWorkersRaw } = require('./shared/workers-registry');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { loadStatusPane, saveStatusPane, removeStatusPane } = require('./shared/status-pane-registry');

const CLI_USAGE = `worker-status.js — ワーカーの稼働状況・連続稼働時間の確認

Usage:
  node worker-status.js status --workspace <path> --worker-name <name>
  node worker-status.js list --workspace <path> [--json]
  node worker-status.js watch --workspace <path> [--interval <sec>]
  node worker-status.js pane --workspace <path> [--interval <sec>] [--direction <dir>] [--percent <pct>]
  node worker-status.js close-pane --workspace <path>

Commands:
  status                 指定ワーカーの生死状態をJSONで照会する
  list                   全ワーカーの稼働状況と連続稼働時間の横棒グラフを表示する
  watch                  横棒グラフを画面クリアしながら定期更新（自動再描画）する
  pane                   WezTermスプリットペインを下部に開き、watchモードを常駐表示する（既存ペインがあれば再利用）
  close-pane             開いているWezTerm監視ペインを終了する

Options:
  --workspace <path>     ワークスペースパス（必須）
  --worker-name <name>   照会するワーカー名（status で必須）
  --json                 list で機械可読な JSON 配列を出力する
  --interval <sec>       watch / pane の更新間隔（秒、既定: 3）
  --direction <dir>      pane の分割方向 (bottom|right|top|left、既定: bottom)
  --percent <pct>        pane の画面占有率 (%、既定: 15)
  --help, -h             このヘルプを表示する

Output (stdout):
  status:
    {"workerName":...,"running":true|false,"pid":...}
  list:
    横棒グラフ、または --json 指定時は [{"workerName":...,"pid":...,"running":...,"startTime":...,"elapsedSeconds":...}]
  pane:
    STATUS_PANE_LAUNCHED: pane=<paneId>
  close-pane:
    STATUS_PANE_CLOSED: pane=<paneId>

Description:
  workers.json のワーカーを読み取り、プロセスの実起動時刻（process-lifecycle.getProcessStartTime）
  に基づいて連続稼働時間を算出する。一覧モードは最長稼働のワーカーを基準にした相対長で横棒グラフを描く。
  pane サブコマンドは WezTerm の専用ペイン（既定: bottom 15%）を分割作成し、独立して自動更新し続ける。
  既存ペインが生存している場合は新しく作らず既存ペインを再利用する。
  close-pane サブコマンドは記録された監視ペインを終了して記録を削除する。`;

let _injectedGetProcessStartTime = null;
let _injectedIsWorkerAlive = null;
let _injectedNow = null;
let _injectedLaunchInSplitPane = null;
let _injectedIsPaneAlive = null;
let _injectedKillPane = null;

function _getProcessStartTime(pid) {
  const fn = _injectedGetProcessStartTime ?? require('./process-lifecycle').getProcessStartTime;
  return fn(pid);
}

function _isWorkerAlive(entry) {
  const fn = _injectedIsWorkerAlive ?? require('./shared/worker-liveness').isWorkerAlive;
  return fn(entry);
}

function _now() {
  const fn = _injectedNow ?? Date.now;
  return fn();
}

function _launchInSplitPane(params) {
  const fn = _injectedLaunchInSplitPane ?? require('./shared/pane-launch').launchInSplitPane;
  return fn(params);
}

function _isPaneAlive(paneId) {
  const fn = _injectedIsPaneAlive ?? require('./shared/pane-launch').isPaneAlive;
  return fn(paneId);
}

function _killPane(paneId) {
  const fn = _injectedKillPane ?? require('./shared/pane-launch').killPane;
  return fn(paneId);
}

/**
 * 秒数を読みやすい時間表記にフォーマットする。
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.floor(s / 60);
  const remSec = s % 60;
  if (mins < 60) return `${mins}m ${remSec}s`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hours}h ${remMin}m ${remSec}s`;
}

/**
 * 全ワーカーの稼働状態と経過秒数を集計する。
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @returns {Array<{workerName: string, pid: number|null, running: boolean, startTime: string|null, elapsedSeconds: number}>}
 */
function collectWorkersStatus(workspace, opts = {}) {
  const now = (opts.nowFn || _now)();
  const getStartTime = opts.getProcessStartTimeFn || _getProcessStartTime;
  const isAlive = opts.isWorkerAliveFn || _isWorkerAlive;

  const rawWorkers = readWorkersRaw(workspace);
  if (!rawWorkers) return [];

  const results = [];
  for (const [workerName, rawEntry] of Object.entries(rawWorkers)) {
    if (workerName === 'orchestrator') continue;
    const entry = normalizeWorkerEntry(rawEntry);
    const running = isAlive(rawEntry);
    let startTime = null;
    let elapsedSeconds = 0;

    if (running && entry.pid) {
      startTime = getStartTime(entry.pid) || entry.startTime || null;
      if (startTime) {
        const startMs = new Date(startTime).getTime();
        if (!Number.isNaN(startMs)) {
          elapsedSeconds = Math.max(0, Math.floor((now - startMs) / 1000));
        }
      }
    }

    results.push({
      workerName,
      pid: entry.pid,
      running,
      startTime,
      elapsedSeconds,
    });
  }
  return results;
}

/**
 * ワーカー一覧から横棒グラフのテキスト行を生成する。
 *
 * @param {Array<{workerName: string, pid: number|null, running: boolean, startTime: string|null, elapsedSeconds: number}>} workers
 * @param {object} [opts]
 * @param {number} [opts.maxBarWidth=30]
 * @returns {string[]}
 */
function renderUptimeBars(workers, opts = {}) {
  if (!workers || workers.length === 0) {
    return ['No workers registered.'];
  }

  const maxBarWidth = opts.maxBarWidth ?? 30;
  const maxElapsed = Math.max(0, ...workers.map(w => w.elapsedSeconds));
  const maxNameLen = Math.max(...workers.map(w => w.workerName.length), 0);

  const lines = [];
  for (const w of workers) {
    const nameCol = w.workerName.padEnd(maxNameLen, ' ');
    const statusCol = w.running ? '[running]' : '[stopped]';
    const timeCol = w.running ? formatDuration(w.elapsedSeconds) : '-';
    let bar = '';
    if (w.running && maxElapsed > 0 && w.elapsedSeconds > 0) {
      const barLen = Math.max(1, Math.round((w.elapsedSeconds / maxElapsed) * maxBarWidth));
      bar = '█'.repeat(barLen);
    }
    const pidStr = w.pid ? `(pid: ${w.pid})` : '';
    const line = `${nameCol}  ${statusCol.padEnd(9, ' ')}  ${timeCol.padStart(8, ' ')}  ${bar ? bar + ' ' : ''}${pidStr}`.trimEnd();
    lines.push(line);
  }
  return lines;
}

const MIN_INTERVAL_SEC = 1;
const MAX_INTERVAL_SEC = 3600;
const DEFAULT_INTERVAL_SEC = 3;

/**
 * --interval の値を検証・数値化する。
 *
 * @param {string|undefined} rawValue
 * @returns {number}
 * @throws {Error} 1〜3600の数値でない場合
 */
function parseInterval(rawValue) {
  if (rawValue === undefined) return DEFAULT_INTERVAL_SEC;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_SEC || n > MAX_INTERVAL_SEC) {
    throw new Error(`--interval には ${MIN_INTERVAL_SEC}〜${MAX_INTERVAL_SEC} の数値を指定してください: ${rawValue}`);
  }
  return n;
}

/**
 * worker-status CLIを実行する。
 *
 * @param {string[]} [argv] process.argv.slice(2) 相当
 * @returns {{code: number, lines: string[], errLines: string[], isWatch?: boolean, workspace?: string, interval?: number, paneId?: string}}
 */
function main(argv = process.argv.slice(2)) {
  const out = [];
  const err = [];
  const writeOut = (line) => out.push(line);
  const writeErr = (line) => err.push(line);

  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: {
        '--workspace': {},
        '--worker-name': {},
        '--interval': {},
        '--direction': {},
        '--percent': {},
      },
      booleans: ['--help', '-h', '--json'],
      positionals: { min: 1, max: 1 },
    }));
  } catch (parseError) {
    if (parseError.name !== 'ArgsValidationError') throw parseError;
    if (parseError.helpRequested) {
      writeOut(CLI_USAGE);
      return { code: 0, lines: out, errLines: [] };
    }
    for (const e of parseError.errors) writeErr(`worker-status: ${e.message}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (values['--help'] || values['-h']) {
    writeOut(CLI_USAGE);
    return { code: 0, lines: out, errLines: err };
  }

  const sub = rest[0];
  const validSubs = new Set(['status', 'list', 'watch', 'pane', 'close-pane']);
  if (!validSubs.has(sub)) {
    writeErr(`worker-status: 未知のサブコマンドです: ${sub}`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (!values['--workspace']) {
    writeErr('worker-status: --workspace が必要です');
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) {
    writeErr('worker-status: ワークスペースを解決できません');
    return { code: 1, lines: out, errLines: err };
  }

  if (sub === 'status') {
    if (!values['--worker-name']) {
      writeErr('worker-status: status には --worker-name が必要です');
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    const workerName = values['--worker-name'];
    let rawWorkers;
    try {
      rawWorkers = readWorkersRaw(workspace);
    } catch (e) {
      writeErr(`worker-status: status の照会に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    const rawEntry = rawWorkers && Object.prototype.hasOwnProperty.call(rawWorkers, workerName)
      ? rawWorkers[workerName]
      : undefined;
    const entry = normalizeWorkerEntry(rawEntry);

    writeOut(JSON.stringify({
      workerName,
      running: _isWorkerAlive(rawEntry),
      pid: entry.pid,
    }));
    return { code: 0, lines: out, errLines: err };
  }

  // list / watch / pane / close-pane では --worker-name は使用不可
  if (values['--worker-name']) {
    writeErr(`worker-status: --worker-name は ${sub} では使用できません`);
    writeErr(CLI_USAGE);
    return { code: 1, lines: out, errLines: err };
  }

  if (sub === 'list') {
    let workers;
    try {
      workers = collectWorkersStatus(workspace);
    } catch (e) {
      writeErr(`worker-status: list の照会に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    if (values['--json']) {
      writeOut(JSON.stringify(workers, null, 2));
    } else {
      const bars = renderUptimeBars(workers);
      for (const line of bars) writeOut(line);
    }
    return { code: 0, lines: out, errLines: err };
  }

  if (sub === 'watch') {
    let interval;
    try {
      interval = parseInterval(values['--interval']);
    } catch (e) {
      writeErr(`worker-status: ${e.message}`);
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    let workers;
    try {
      workers = collectWorkersStatus(workspace);
    } catch (e) {
      writeErr(`worker-status: watch の照会に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    const timestamp = new Date(_now()).toISOString();
    writeOut(`=== gh-maestro worker status (${timestamp}, interval: ${interval}s) ===`);
    const bars = renderUptimeBars(workers);
    for (const line of bars) writeOut(line);

    return { code: 0, lines: out, errLines: err, isWatch: true, workspace, interval };
  }

  if (sub === 'pane') {
    let interval;
    try {
      interval = parseInterval(values['--interval']);
    } catch (e) {
      writeErr(`worker-status: ${e.message}`);
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    const direction = values['--direction'] || 'bottom';
    const validDirs = new Set(['bottom', 'right', 'top', 'left']);
    if (!validDirs.has(direction)) {
      writeErr(`worker-status: --direction は bottom|right|top|left のいずれかを指定してください: ${direction}`);
      writeErr(CLI_USAGE);
      return { code: 1, lines: out, errLines: err };
    }

    let percent = 15;
    if (values['--percent'] !== undefined) {
      const p = Number(values['--percent']);
      if (!Number.isFinite(p) || p <= 0 || p >= 100) {
        writeErr(`worker-status: --percent は 1〜99 の数値を指定してください: ${values['--percent']}`);
        writeErr(CLI_USAGE);
        return { code: 1, lines: out, errLines: err };
      }
      percent = p;
    }

    // 既存ペインの確認・再利用
    const existingPane = loadStatusPane(workspace);
    if (existingPane && existingPane.paneId && _isPaneAlive(existingPane.paneId)) {
      writeOut(`STATUS_PANE_LAUNCHED: pane=${existingPane.paneId}`);
      return { code: 0, lines: out, errLines: err, paneId: existingPane.paneId, reused: true };
    }

    let paneResult;
    try {
      paneResult = _launchInSplitPane({
        argv: [process.execPath, __filename, 'watch', '--workspace', workspace, '--interval', String(interval)],
        cwd: workspace,
        direction,
        percent,
      });
    } catch (e) {
      writeErr(`worker-status: pane の分割起動に失敗しました: ${e.message}`);
      return { code: 1, lines: out, errLines: err };
    }

    try {
      saveStatusPane(workspace, {
        paneId: paneResult.paneId,
        launchedAt: new Date(_now()).toISOString(),
      });
    } catch (e) {
      writeErr(`worker-status: 監視ペイン状態の保存に失敗しました: ${e.message}`);
    }

    writeOut(`STATUS_PANE_LAUNCHED: pane=${paneResult.paneId}`);
    return { code: 0, lines: out, errLines: err, paneId: paneResult.paneId, reused: false };
  }

  if (sub === 'close-pane') {
    const existingPane = loadStatusPane(workspace);
    if (!existingPane || !existingPane.paneId) {
      writeOut('STATUS_PANE_NOT_FOUND');
      return { code: 0, lines: out, errLines: err };
    }

    const paneId = existingPane.paneId;
    if (_isPaneAlive(paneId)) {
      const killResult = _killPane(paneId);
      if (!killResult.ok) {
        writeErr(`worker-status: 監視ペイン ${paneId} の終了に失敗しました: ${killResult.stderr}`);
        return { code: 1, lines: out, errLines: err };
      }
    }

    removeStatusPane(workspace);
    writeOut(`STATUS_PANE_CLOSED: pane=${paneId}`);
    return { code: 0, lines: out, errLines: err, paneId };
  }

  return { code: 0, lines: out, errLines: err };
}

function runWatchLoop(workspace, interval, opts = {}) {
  const intervalMs = interval * 1000;
  const outStream = opts.stdout || process.stdout;
  const errStream = opts.stderr || process.stderr;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const onSignalFn = opts.onSignalFn || ((sig, handler) => process.on(sig, handler));
  const exitFn = opts.exitFn || process.exit;

  const render = () => {
    try {
      const workers = collectWorkersStatus(workspace, opts);
      const bars = renderUptimeBars(workers, opts);
      const timestamp = new Date(_now()).toISOString();
      outStream.write('\x1b[2J\x1b[H');
      outStream.write(`=== gh-maestro worker status (${timestamp}, interval: ${interval}s) ===\n`);
      for (const line of bars) {
        outStream.write(line + '\n');
      }
    } catch (e) {
      errStream.write(`worker-status: watch 更新エラー: ${e.message}\n`);
    }
  };

  render();
  const timer = setIntervalFn(render, intervalMs);
  const handleSignal = () => {
    clearIntervalFn(timer);
    exitFn(0);
  };
  onSignalFn('SIGINT', handleSignal);
  onSignalFn('SIGTERM', handleSignal);

  return { timer, render, handleSignal };
}

module.exports = {
  main,
  CLI_USAGE,
  formatDuration,
  collectWorkersStatus,
  renderUptimeBars,
  parseInterval,
  runWatchLoop,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  DEFAULT_INTERVAL_SEC,
  _setGetProcessStartTime: (fn) => { _injectedGetProcessStartTime = fn; },
  _setIsWorkerAlive: (fn) => { _injectedIsWorkerAlive = fn; },
  _setNow: (fn) => { _injectedNow = fn; },
  _setLaunchInSplitPane: (fn) => { _injectedLaunchInSplitPane = fn; },
  _setIsPaneAlive: (fn) => { _injectedIsPaneAlive = fn; },
  _setKillPane: (fn) => { _injectedKillPane = fn; },
};

if (require.main === module) {
  const result = main();
  for (const line of result.errLines) process.stderr.write(line + '\n');
  if (result.code !== 0) {
    process.exit(result.code);
  }
  if (result.isWatch) {
    runWatchLoop(result.workspace, result.interval);
  } else {
    for (const line of result.lines) process.stdout.write(line + '\n');
    process.exit(result.code);
  }
}

