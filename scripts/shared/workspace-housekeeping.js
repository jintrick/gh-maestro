'use strict';

// lifecycle sweep 配下でだけ呼び出す、workspace内の実行時ゴミ掃除。
// 独自のプロセス生存判定やスケジューラは持たず、呼び出し元（collect-housekeeping-exclusions）
// が確定した除外対象ワーカー（excludedWorkerNames / excludedReviewPrs）のログを
// ローテーション対象から除外する。

const fs = require('fs');
const path = require('path');
const { recordRoot } = require('./record-paths');

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

function listRecordLogs(root, relative = '', output = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const rel = path.join(relative, entry.name);
    const full = path.join(root, rel);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) listRecordLogs(root, rel, output);
    else if (stat.isFile() && /\.log(?:\.\d+)?$/.test(entry.name)) output.push(full);
  }
  return output;
}

function removeOldRecordTemps(root, now, results, dryRun, relative = '') {
  let entries;
  try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const rel = path.join(relative, entry.name);
    const full = path.join(root, rel);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { removeOldRecordTemps(root, now, results, dryRun, rel); continue; }
    if (!stat.isFile() || !(entry.name.includes('.compact-') || entry.name.startsWith('.staging-')
      || /\.(?:json|log)\.[A-Za-z0-9]{6}$/.test(entry.name))) continue;
    try {
      if (now - stat.mtimeMs < TEMP_MIN_AGE_MS) continue;
      if (!dryRun) fs.unlinkSync(full);
      results.removed.push(full);
    } catch (error) { results.errors.push(`${full}: ${error.message}`); }
  }
}

function sweepWorkspaceFiles(workspace, { excludedWorkerNames = new Set(), excludedReviewPrs = new Set(), now = Date.now(), dryRun = false } = {}) {
  const results = { removed: [], compacted: [], rotated: [], errors: [] };
  const maestro = path.join(workspace, '.gh-maestro');
  const records = recordRoot(workspace);
  removeOldRecordTemps(records, now, results, dryRun);
  const logs = listRecordLogs(records).filter((filePath) => /\.log$/.test(filePath));
  // 上限を超えた世代は、現在ログのローテーション有無に関係なく削除する。
  const generations = listRecordLogs(records).filter((filePath) => /\.log\.\d+$/.test(filePath));
  for (const generationPath of generations) {
    const name = path.basename(generationPath);
    const generation = Number(name.slice(name.lastIndexOf('.') + 1));
    if (generation <= MAX_LOG_GENERATIONS || !isRegularFile(generationPath)) continue;
    try {
      if (!dryRun) fs.unlinkSync(generationPath);
      results.removed.push(generationPath);
    } catch (error) {
      results.errors.push(`${generationPath}: ${error.message}`);
    }
  }
  for (const logPath of logs) {
    const relative = path.relative(records, logPath).split(path.sep);
    const workerIndex = relative.indexOf('workers');
    const workerName = workerIndex >= 0 ? relative[workerIndex + 1] : null;
    const prMatch = /^pr$/.test(relative[0]) ? relative[1] : null;
    const reviewManagerWorker = workerName && prMatch
      && workerName.endsWith(`-review-manager-pr-${prMatch}`);
    if ((workerName && excludedWorkerNames.has(workerName))
      || (prMatch && excludedReviewPrs.has(prMatch)
        && (relative.includes('review') || reviewManagerWorker))) continue;
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

  // worker-supervisor-autostart.log は supervisor 起動時に stdout/stderr の向き先として
  // 開かれ、無制限に肥大化しうる。worker-logs と同一の rotateLog（MAX_LOG_GENERATIONS=3）
  // でサイズ超過時に世代ローテーションする（Issue #248 項目5）。supervisor 稼働中は
  // ログfdが掴まれたままのため、Windows では rename が失敗し results.errors に記録される
  // が、非破壊の best-effort である。停止中（次回起動前）の sweep では確実に回転できる。
  const autostartLog = path.join(maestro, 'worker-supervisor-autostart.log');
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
