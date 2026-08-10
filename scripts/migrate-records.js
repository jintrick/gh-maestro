#!/usr/bin/env node
'use strict';

// Explicit, idempotent migration from pre-#254 record locations.
// This script is intentionally not imported by install or any daemon startup.

const fs = require('fs');
const path = require('path');
const { parseFlags, hasHelpFlag, resolveWorkspace } = require('./shared/workspace');
const { isProcessAlive } = require('./process-lifecycle');
const { readWorkersRaw } = require('./shared/workers-registry');
const { isWorkerAlive } = require('./shared/worker-liveness');
const {
  ARTIFACTS, assertWithinRoot, legacyWorkerOwner, recordPath, recordRoot,
} = require('./shared/record-paths');

const USAGE = `migrate-records.js — 旧配置の番号所有レコードを records/ 配下へ移動する

Usage: node migrate-records.js [--workspace <path>] [--dry-run]
                              [--scope <all|worker-log|review-manager|inbox-supervisor|assistant-watch>]

Options:
  --workspace <path>  対象ワークスペース（省略時は共通workspace解決規則を使用）
  --dry-run           移動せず、同じ計画と分類だけを表示する
  --scope <name>      対象コンポーネント（既定: all）
  --help, -h          このヘルプを表示する

出力分類: moved, already-migrated, held, conflict, unparseable, unprocessed。
対象は指定workspaceの .gh-maestro/ 配下だけで、記録内容・保持期間・削除条件は変更しない。`;

const SCOPES = new Set(['all', 'worker-log', 'review-manager', 'inbox-supervisor', 'assistant-watch']);

function result() {
  return { moved: [], alreadyMigrated: [], held: [], conflicts: [], unparseable: [], unprocessed: [] };
}

function regularFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) files.push({ name: entry.name, path: full });
  }
  return files;
}

function addGeneration(base, sourceName) {
  const generation = /\.log(\.\d+)$/.exec(sourceName);
  return generation ? `${base}${generation[1]}` : base;
}

function classifyWorkerLog(workspace, file) {
  const name = file.name;
  const baseName = name.replace(/\.log(?:\.\d+)?$/, '');
  let owner;
  if (/^review-manager-[1-9]\d*$/.test(baseName)) {
    const pr = baseName.slice('review-manager-'.length);
    return { kind: 'review-manager', ownerKind: 'pr', ownerId: pr,
      artifact: ARTIFACTS.REVIEW_MANAGER_LOG, destination: recordPath(workspace, {
        ownerKind: 'pr', ownerId: pr, artifact: ARTIFACTS.REVIEW_MANAGER_LOG,
      }) };
  }
  try { owner = legacyWorkerOwner(baseName); } catch { return null; }
  const artifact = ARTIFACTS.WORKER_LOG;
  return { kind: 'worker-log', owner, artifact,
    destination: addGeneration(recordPath(workspace, { ...owner, artifact }), name) };
}

function classifyDirectReview(workspace, file) {
  let match = /^review-manager-([1-9]\d*)\.(json|running|incomplete)$/.exec(file.name);
  if (match) {
    const artifact = {
      json: ARTIFACTS.REVIEW_MANAGER_JSON,
      running: ARTIFACTS.REVIEW_MANAGER_RUNNING,
      incomplete: ARTIFACTS.REVIEW_MANAGER_INCOMPLETE,
    }[match[2]];
    return { kind: 'review-manager', ownerKind: 'pr', ownerId: match[1], artifact,
      destination: recordPath(workspace, { ownerKind: 'pr', ownerId: match[1], artifact }) };
  }
  match = /^review-manifest-([1-9]\d*)\.json$/.exec(file.name);
  if (match) return { kind: 'review-manager', ownerKind: 'pr', ownerId: match[1],
    artifact: ARTIFACTS.REVIEW_MANIFEST,
    destination: recordPath(workspace, {
      ownerKind: 'pr', ownerId: match[1], artifact: ARTIFACTS.REVIEW_MANIFEST,
    }) };
  return null;
}

function classifyScoped(workspace, source, component, file) {
  if (!file) return null;
  if (component === 'worker-log') return classifyWorkerLog(workspace, file);
  if (component === 'review-manager') return classifyDirectReview(workspace, file);
  if (component === 'assistant-watch') {
    const match = /^(?:issue-)?([1-9]\d*)\.json$/.exec(file.name);
    if (!match) return null;
    return { kind: component, ownerKind: 'issue', ownerId: match[1], artifact: ARTIFACTS.ASSISTANT_WATCH,
      destination: recordPath(workspace, {
        ownerKind: 'issue', ownerId: match[1], artifact: ARTIFACTS.ASSISTANT_WATCH,
      }) };
  }
  if (component === 'inbox-supervisor') {
    const owner = legacyWorkerOwner(file.name.replace(/\.json$/, ''));
    const artifact = source.includes(`${path.sep}cursors${path.sep}`)
      ? ARTIFACTS.CURSOR : ARTIFACTS.CONTRACT;
    return { kind: component, owner, artifact,
      destination: recordPath(workspace, { ...owner, artifact }) };
  }
  return classifyWorkerLog(workspace, file)
    || classifyDirectReview(workspace, file)
    || classifyScoped(workspace, source, 'assistant-watch', file)
    || (() => {
      try { return classifyScoped(workspace, source, 'inbox-supervisor', file); } catch { return null; }
    })();
}

function reviewManagerIsLive(workspace, pr) {
  const running = path.join(workspace, '.gh-maestro', `review-manager-${pr}.running`);
  try {
    const raw = fs.readFileSync(running, 'utf8').trim();
    let pid = Number(raw);
    if (!Number.isInteger(pid) && raw.startsWith('{')) pid = Number(JSON.parse(raw).pid);
    return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid);
  } catch { return false; }
}

function ownerIsLive(workspace, item) {
  if (item.kind === 'review-manager') return reviewManagerIsLive(workspace, item.ownerId);
  if (!item.owner || item.owner.ownerKind !== 'issue') return false;
  let workers;
  try { workers = readWorkersRaw(workspace); } catch { return true; }
  const entry = workers && workers[item.owner.workerName];
  if (!entry) return false;
  try { return isWorkerAlive(entry); } catch { return true; }
}

function sameBytes(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function migrateOne(workspace, item, source, out, dryRun) {
  const records = recordRoot(workspace);
  const sourcePath = path.resolve(source);
  const destination = assertWithinRoot(records, item.destination);
  if (ownerIsLive(workspace, item)) {
    out.held.push({ source: sourcePath, destination, reason: 'owner process is live' });
    return;
  }
  if (fs.existsSync(destination)) {
    if (sameBytes(sourcePath, destination)) {
      out.alreadyMigrated.push({ source: sourcePath, destination });
      if (!dryRun) fs.unlinkSync(sourcePath);
    } else out.conflicts.push({ source: sourcePath, destination, reason: 'destination differs' });
    return;
  }
  out.moved.push({ source: sourcePath, destination });
  if (dryRun) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.renameSync(sourcePath, destination); } catch (e) {
    out.unprocessed.push({ source: sourcePath, destination, reason: e.message });
    out.moved.pop();
  }
}

function planMigration(workspace, scope, { dryRun = false } = {}) {
  const out = result();
  const gh = path.join(workspace, '.gh-maestro');
  const processFiles = (dir, component) => {
    for (const file of regularFiles(dir)) {
      let item;
      try { item = classifyScoped(workspace, dir, component, file); } catch {
        out.unparseable.push({ source: file.path, reason: 'legacy name cannot be parsed' });
        continue;
      }
      if (!item) { out.unparseable.push({ source: file.path, reason: 'legacy name cannot be parsed' }); continue; }
      migrateOne(workspace, item, file.path, out, dryRun);
    }
  };
  if (scope === 'all' || scope === 'worker-log') processFiles(path.join(gh, 'worker-logs'), 'worker-log');
  if (scope === 'all' || scope === 'review-manager') processFiles(gh, 'review-manager');
  if (scope === 'all' || scope === 'assistant-watch') processFiles(path.join(gh, 'assistant-watch'), 'assistant-watch');
  if (scope === 'all' || scope === 'inbox-supervisor') {
    processFiles(path.join(gh, 'inbox-supervisor', 'cursors'), 'inbox-supervisor');
    processFiles(path.join(gh, 'inbox-supervisor', 'contracts'), 'inbox-supervisor');
  }
  return out;
}

function printResult(workspace, scope, dryRun, out) {
  const summary = {
    workspace, scope, dryRun,
    counts: Object.fromEntries(Object.entries(out).map(([key, values]) => [key, values.length])),
    details: out,
  };
  console.log(JSON.stringify(summary, null, 2));
  return out.conflicts.length || out.unparseable.length || out.held.length || out.unprocessed.length ? 1 : 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--workspace', '--scope'], ['--dry-run']);
  if (hasHelpFlag(rest)) { console.log(USAGE); process.exit(0); }
  if (exitFlagMiss || rest.length > 0) { console.error(USAGE); process.exit(1); }
  const scope = values['--scope'] || 'all';
  if (!SCOPES.has(scope)) { console.error(`migrate-records: invalid scope: ${scope}`); console.error(USAGE); process.exit(1); }
  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) { console.error('migrate-records: ワークスペースを解決できません。'); process.exit(1); }
  try {
    const out = planMigration(workspace, scope, { dryRun: !!values['--dry-run'] });
    process.exit(printResult(workspace, scope, !!values['--dry-run'], out));
  } catch (e) {
    console.error(`migrate-records: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {
  SCOPES,
  classifyWorkerLog,
  classifyDirectReview,
  planMigration,
  ownerIsLive,
};
