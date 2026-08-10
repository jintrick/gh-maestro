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
const { getAssistant } = require('./shared/assistants-registry');
const { markMigrationInProgress, clearMigrationInProgress } = require('./shared/migration-marker');
const { runningInboxSupervisorPids, stopRunningInboxSupervisors } = require('./shared/inbox-supervisor-control');
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
対象は指定workspaceの .gh-maestro/ 配下だけで、記録内容・保持期間・削除条件は変更しない。

--scope が inbox-supervisor または all の場合:
  - 稼働中の inbox-supervisor を検知し、ツール自身が停止してから移行する
    （--dry-run では停止せず、notices に「実実行時に停止する」旨を出す）
  - 実行中は .gh-maestro/.migration-in-progress マーカーを作成して inbox-supervisor の
    自動起動を抑制し、完了時に削除する（再開は既存の自動起動機構に任せる）
assistant-watch は、対象issueのassistantが assistants.json に登録されている間は
held（assistant agent is running）となり移行しない（対話型assistantは強制終了しない）。
出力JSONには notices 配列が含まれ、プロセスの停止・検知情報が記録される。`;

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
    // source はこのファイルが置かれているディレクトリ（inbox-supervisor/cursors or
    // inbox-supervisor/contracts）。ディレクトリ名でアーティファクトを判定する。
    // 旧実装はファイルパスに対する contains 判定をしていたが、呼び出し側が dir を
    // 渡しており `\cursors\` に永遠に一致せず、cursors/ の全ファイルが contract.json に
    // 移行されてしまう不具合があった（Issue #256 の実機検証で発見）。
    const artifact = source.endsWith(`${path.sep}cursors`) ? ARTIFACTS.CURSOR : ARTIFACTS.CONTRACT;
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

/**
 * 対象レコードを移行せず held にすべき理由を返す（なければ null）。
 *
 * assistant-watch は対象issueの対話型assistantが assistants.json に登録されている間は
 * 無条件で held とする。assistant は人間が会話中の可能性がある窓口であり、ツールが
 * 強制終了・状態移行を行ってはならない（Issue #256）。assistants.json の読み取りは
 * loadAssistants の「存在しない・壊れている場合は空として扱う」規約に従い、読めない
 * 場合は assistant が登録されていないものとして移行を許可する。
 */
function holdReason(workspace, item) {
  if (item.kind === 'assistant-watch' && getAssistant(workspace, item.ownerId) !== null) {
    return 'assistant agent is running';
  }
  if (ownerIsLive(workspace, item)) return 'owner process is live';
  return null;
}

function sameBytes(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

function migrateOne(workspace, item, source, out, dryRun) {
  const records = recordRoot(workspace);
  const sourcePath = path.resolve(source);
  const destination = assertWithinRoot(records, item.destination);
  const reason = holdReason(workspace, item);
  if (reason) {
    out.held.push({ source: sourcePath, destination, reason });
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

function printResult(workspace, scope, dryRun, out, notices = []) {
  const summary = {
    workspace, scope, dryRun,
    counts: Object.fromEntries(Object.entries(out).map(([key, values]) => [key, values.length])),
    details: out,
    notices,
  };
  console.log(JSON.stringify(summary, null, 2));
  return out.conflicts.length || out.unparseable.length || out.held.length || out.unprocessed.length ? 1 : 0;
}

function shouldControlInboxSupervisor(scope) {
  return scope === 'all' || scope === 'inbox-supervisor';
}

/**
 * inbox-supervisor の停止・自動起動抑制を移行実行の前後に適用する。
 *
 * - scope が対象外なら fn を素通しする
 * - dry-run は副作用なし（停止・マーカー作成を行わない）。稼働中の supervisor が
 *   いれば notice で「実実行時に停止する」旨を返す
 * - 実実行は、マーカーを作成して自動起動を抑制 → 稼働中 supervisor を停止 → fn →
 *   finally でマーカーを確実に削除する。inbox-supervisor の再開は既存の自動起動機構
 *   （ensure-inbox-supervisor.js）が次に必要とした時点で引き受けるため、ここでは
 *   明示的に再起動しない
 *
 * マーカー作成を停止より先に行うのは、kill→mark の順だと抑制が確立する前に並行する
 * msg-send.js / spawn-worker.js が supervisor を再起動しうる窓が残るため（Issue #256）。
 *
 * @param {string} workspace
 * @param {string} scope
 * @param {{dryRun: boolean}} opts
 * @param {(notice: string|null) => *} fn  実行本体。notice 文字列を引数で受け取る
 * @returns {*} fn の戻り値
 */
function runWithInboxSupervisorControl(workspace, scope, { dryRun }, fn) {
  if (!shouldControlInboxSupervisor(scope)) return fn(null);

  const running = runningInboxSupervisorPids(workspace);
  if (dryRun) {
    return fn(running.length
      ? `inbox-supervisor は稼働中です（pid: ${running.join(', ')}）。実実行時に停止してから移行します。`
      : null);
  }

  markMigrationInProgress(workspace);
  try {
    const stopped = stopRunningInboxSupervisors(workspace);
    return fn(stopped.length
      ? `稼働中の inbox-supervisor（pid: ${stopped.join(', ')}）を停止しました。移行完了後に自動起動機構が再開します。`
      : null);
  } finally {
    clearMigrationInProgress(workspace);
  }
}

function main(argv) {
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--workspace', '--scope'], ['--dry-run']);
  if (hasHelpFlag(rest)) { console.log(USAGE); return 0; }
  if (exitFlagMiss || rest.length > 0) { console.error(USAGE); return 1; }
  const scope = values['--scope'] || 'all';
  if (!SCOPES.has(scope)) { console.error(`migrate-records: invalid scope: ${scope}`); console.error(USAGE); return 1; }
  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) { console.error('migrate-records: ワークスペースを解決できません。'); return 1; }
  const dryRun = !!values['--dry-run'];
  try {
    const notices = [];
    const out = runWithInboxSupervisorControl(workspace, scope, { dryRun }, (notice) => {
      if (notice) notices.push(notice);
      return planMigration(workspace, scope, { dryRun });
    });
    return printResult(workspace, scope, dryRun, out, notices);
  } catch (e) {
    console.error(`migrate-records: ${e.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  SCOPES,
  classifyWorkerLog,
  classifyDirectReview,
  planMigration,
  ownerIsLive,
  shouldControlInboxSupervisor,
  runWithInboxSupervisorControl,
  main,
};
