'use strict';

// lifecycle sweep 配下でだけ呼び出す、workspace内の実行時ゴミ掃除。
// 独自のプロセス生存判定やスケジューラは持たず、呼び出し元が確定した
// activeWorkerNames だけを保護する。

const fs = require('fs');
const path = require('path');

const MAX_WORKER_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_GENERATIONS = 3;
const TEMP_MIN_AGE_MS = 60 * 1000;

function isRegularFile(filePath) {
  try { return fs.lstatSync(filePath).isFile(); } catch { return false; }
}

function removeOldFiles(dir, predicate, now, results, dryRun) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!predicate(name)) continue;
    const filePath = path.join(dir, name);
    if (!isRegularFile(filePath)) continue;
    try {
      if (now - fs.statSync(filePath).mtimeMs < TEMP_MIN_AGE_MS) continue;
      if (!dryRun) fs.unlinkSync(filePath);
      results.removed.push(filePath);
    } catch (error) {
      results.errors.push(`${filePath}: ${error.message}`);
    }
  }
}

function rotateLog(logPath, results, dryRun) {
  if (dryRun) {
    results.rotated.push(logPath);
    return;
  }
  try {
    for (let generation = MAX_LOG_GENERATIONS - 1; generation >= 1; generation--) {
      const source = `${logPath}.${generation}`;
      const target = `${logPath}.${generation + 1}`;
      if (!fs.existsSync(source)) continue;
      try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.renameSync(source, target);
    }
    const first = `${logPath}.1`;
    try { fs.unlinkSync(first); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(logPath, first);
    fs.writeFileSync(logPath, '', 'utf8');
    results.rotated.push(logPath);
  } catch (error) {
    results.errors.push(`${logPath}: ${error.message}`);
  }
}

function sweepWorkspaceFiles(workspace, { activeWorkerNames = new Set(), activeReviewPrs = new Set(), now = Date.now(), dryRun = false } = {}) {
  const results = { removed: [], compacted: [], rotated: [], errors: [] };
  const maestro = path.join(workspace, '.gh-maestro');
  const workerLogDir = path.join(maestro, 'worker-logs');

  removeOldFiles(workerLogDir,
    (name) => name.includes('.compact-') && name.endsWith('.tmp') || name.startsWith('.staging-'), now, results, dryRun);
  removeOldFiles(path.join(maestro, 'assistant-watch'),
    (name) => !name.endsWith('.json'), now, results, dryRun);
  removeOldFiles(path.join(maestro, 'inbox-supervisor', 'cursors'),
    (name) => !name.endsWith('.json'), now, results, dryRun);
  removeOldFiles(path.join(maestro, 'msg-state'),
    (name) => !name.endsWith('.json'), now, results, dryRun);

  let logs;
  try { logs = fs.readdirSync(workerLogDir).filter(name => name.endsWith('.log')); } catch { logs = []; }
  // 上限を超えた世代は、現在ログのローテーション有無に関係なく削除する。
  let generations = [];
  try {
    generations = fs.readdirSync(workerLogDir).filter(name => /\.log\.\d+$/.test(name));
  } catch {}
  for (const name of generations) {
    const generation = Number(name.slice(name.lastIndexOf('.') + 1));
    if (generation <= MAX_LOG_GENERATIONS || !isRegularFile(path.join(workerLogDir, name))) continue;
    const generationPath = path.join(workerLogDir, name);
    try {
      if (!dryRun) fs.unlinkSync(generationPath);
      results.removed.push(generationPath);
    } catch (error) {
      results.errors.push(`${generationPath}: ${error.message}`);
    }
  }
  for (const name of logs) {
    const workerName = name.slice(0, -4);
    const reviewMatch = /-pr-(\d+)\.log$/.exec(name);
    if (activeWorkerNames.has(workerName)
      || (reviewMatch && activeReviewPrs.has(reviewMatch[1]))) continue;
    const logPath = path.join(workerLogDir, name);
    if (!isRegularFile(logPath)) continue;
    if (dryRun) {
      try { if (fs.statSync(logPath).size > MAX_WORKER_LOG_BYTES) results.rotated.push(logPath); } catch {}
      continue;
    }
    try {
      // ログ圧縮は worker-exit-hook.js（ワーカー終了後の安全なタイミング）と手動CLI
      // cleanup-worker-logs.js のみが行う。sweep は稼働中ログに触れる圧縮経路を持たない
      // （Issue #248 項目8。PR #239 の回帰を根本除去）。ここではサイズ超過時の世代
      // ローテーションのみ行う。
      if (fs.statSync(logPath).size > MAX_WORKER_LOG_BYTES) rotateLog(logPath, results, dryRun);
    } catch (error) {
      results.errors.push(`${logPath}: ${error.message}`);
    }
  }

  // inbox-supervisor-autostart.log は supervisor 起動時に stdout/stderr の向き先として
  // 開かれ、無制限に肥大化しうる。worker-logs と同一の rotateLog（MAX_LOG_GENERATIONS=3）
  // でサイズ超過時に世代ローテーションする（Issue #248 項目5）。supervisor 稼働中は
  // ログfdが掴まれたままのため、Windows では rename が失敗し results.errors に記録される
  // が、非破壊の best-effort である。停止中（次回起動前）の sweep では確実に回転できる。
  const autostartLog = path.join(maestro, 'inbox-supervisor-autostart.log');
  if (isRegularFile(autostartLog)) {
    try {
      if (fs.statSync(autostartLog).size > MAX_WORKER_LOG_BYTES) rotateLog(autostartLog, results, dryRun);
    } catch (error) {
      results.errors.push(`${autostartLog}: ${error.message}`);
    }
  }
  return results;
}

module.exports = {
  MAX_WORKER_LOG_BYTES,
  MAX_LOG_GENERATIONS,
  TEMP_MIN_AGE_MS,
  sweepWorkspaceFiles,
};
