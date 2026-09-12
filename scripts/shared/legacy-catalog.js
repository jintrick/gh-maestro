'use strict';
// legacy-catalog.js — 既知のレガシー遺物を非破壊で検査する共通入口
//
// 台帳のメタデータは ../legacy-catalog.json に置き、異質な判定だけを項目別 detector
// としてここに置く。inspectLegacyArtifacts は detector の呼び出しと結果集約に徹し、
// 整理用の削除・移行・kill能力はコンテキストへ渡さない。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { _validateAgainstSchema } = require('./json-schema');
const { readFileAtRef } = require('./git-ref');
const { readState } = require('./read-state');
const { readWorkersRaw } = require('./workers-registry');
const processLifecycle = require('../process-lifecycle');
const { isWorkerAlive } = require('./worker-liveness');
const workerLease = require('./worker-lease');
const { deriveRoleFromSkill } = require('./worker-factory');
const storageLayout = require('./storage-layout');

const DECLARATION = require('../legacy-catalog.json');
const DECLARATION_SCHEMA = require('../legacy-catalog-schema.json');

const ITEM_STATES = Object.freeze(['present', 'absent', 'unknown', 'not_applicable']);
const COMPLETENESS_STATES = Object.freeze(['complete', 'incomplete']);
const LEGACY_AI_REVIEW_PATHS = Object.freeze([
  '.github/workflows/reviewer.lock.yml',
  '.github/workflows/reviewer.md',
  '.github/workflows/shared/reviewer-output-policy.md',
]);
const LEGACY_REPOSITORY_REFS = Object.freeze(['main', 'dev']);
const LEGACY_RECORD_DIRS = Object.freeze([
  'worker-logs',
  'review-manager',
  path.join('assistant-watch'),
  path.join('inbox-supervisor'),
]);
const LEGACY_MANAGED_ENTRIES = Object.freeze([
  'workflows',
  '.claude',
  'GH_MAESTRO_REF',
  'review-policy.md',
]);
const LEGACY_ROLELESS_WORKER_RE = /^issue-\d+-(?!coder-|senior-coder-|explorer-|diagnostician-|architect-|review-manager-|base-|assistant-)[A-Za-z0-9_-]+$/;
const LEGACY_SUPERVISOR_SCRIPT = 'inbox-supervisor.js';
const LEGACY_SUPERVISOR_ROLE = 'inbox-supervisor';
const LEGACY_TYPO_SUPERVISOR_ROLE = 'inbose-supervisor';
const CHECKS_MARKER_RE = /^# gh-maestro:checks(?::v\d+)?$/;
const SYNC_RULES_MARKER_RE = /^# gh-maestro:sync-rules(?::v\d+)?$/;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateCatalogDeclaration(value) {
  const errors = _validateAgainstSchema(value, DECLARATION_SCHEMA, 'catalog');
  if (errors.length > 0) return errors;

  const ids = new Set();
  for (const [index, item] of value.items.entries()) {
    if (ids.has(item.id)) errors.push(`catalog.items[${index}].id: duplicate '${item.id}'`);
    ids.add(item.id);
  }
  if (value.expectedItemCount !== value.items.length) {
    errors.push(
      `catalog.expectedItemCount: expected ${value.expectedItemCount}, actual ${value.items.length}`,
    );
  }
  return errors;
}

const declarationErrors = validateCatalogDeclaration(DECLARATION);
if (declarationErrors.length > 0) {
  throw new Error(`legacy catalog is invalid:\n${declarationErrors.join('\n')}`);
}

const CATALOG = Object.freeze(DECLARATION.items.map((item) => Object.freeze({
  ...item,
  requiredCapabilities: Object.freeze(item.requiredCapabilities.slice()),
})));

function unknown(reason) {
  return { status: 'unknown', reason };
}

function absent(reason) {
  return { status: 'absent', ...(reason ? { reason } : {}) };
}

function present(evidence) {
  return { status: 'present', ...(evidence ? { evidence } : {}) };
}

function notApplicable(reason) {
  return { status: 'not_applicable', reason };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultReadGit(args, workspace) {
  let result;
  try {
    result = spawnSync('git', args, {
      cwd: workspace,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    return { status: 'unknown', reason: errorMessage(error) };
  }
  if (!result || result.error || result.status === null || result.status === undefined) {
    return {
      status: 'unknown',
      reason: result?.error?.message || 'git process did not provide an exit status',
    };
  }
  if (result.status === 0) {
    return { status: 'ok', value: String(result.stdout || '').trim() };
  }

  const stderr = String(result.stderr || '').trim();
  if (result.status === 1 && args[0] === 'config' && args[1] === '--get' && !stderr) {
    return { status: 'absent', value: '' };
  }
  return { status: 'unknown', reason: stderr || `git exited with status ${result.status}` };
}

function readGitConfig(workspace, key) {
  return defaultReadGit(['config', '--get', key], workspace);
}

function readGitDir(workspace) {
  return defaultReadGit(['rev-parse', '--git-dir'], workspace);
}

function makeCapabilities(options) {
  const overrides = options.capabilities && typeof options.capabilities === 'object'
    ? options.capabilities
    : {};
  const defaults = {
    lstat: (filePath) => fs.lstatSync(filePath),
    readdir: (directory) => fs.readdirSync(directory, { withFileTypes: true }),
    readFile: (filePath, encoding = 'utf8') => fs.readFileSync(filePath, encoding),
    readRef: (workspace, ref, filePath) => readFileAtRef(workspace, ref, filePath),
    readGitConfig,
    readGitDir,
    readWorkers: (workspace) => readWorkersRaw(workspace),
    isProcessAlive: processLifecycle.isProcessAlive,
    verifyProcessIdentity: processLifecycle.verifyProcessIdentity,
    isWorkerAlive,
    isLeaseLive: workerLease.isLeaseLive,
    isResidentLeaseLive: workerLease.isResidentLeaseLive,
  };
  const capabilities = {};
  for (const key of Object.keys(defaults)) {
    capabilities[key] = own(overrides, key) ? overrides[key] : defaults[key];
  }
  return capabilities;
}

function createContext(options = {}) {
  const workspace = typeof options.workspace === 'string' && options.workspace !== ''
    ? path.resolve(options.workspace)
    : null;
  return {
    workspace,
    managedRoot: options.managedRoot === undefined
      ? storageLayout.managedRoot()
      : options.managedRoot,
    runtimeRoot: options.runtimeRoot === undefined
      ? storageLayout.runtimeRoot()
      : options.runtimeRoot,
    capabilities: makeCapabilities(options),
    caches: new Map(),
  };
}

function pathState(context, target) {
  if (typeof context.capabilities.lstat !== 'function') return unknown('lstat capability is unavailable');
  try {
    const stat = context.capabilities.lstat(target);
    return present(`${target} (${stat.isDirectory() ? 'directory' : 'file'})`);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return absent(target);
    return unknown(`${target} の存在確認に失敗しました: ${errorMessage(error)}`);
  }
}

function textState(context, target) {
  if (typeof context.capabilities.readFile !== 'function') {
    return unknown('readFile capability is unavailable');
  }
  try {
    return { status: 'present', content: String(context.capabilities.readFile(target, 'utf8')) };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return absent(target);
    return unknown(`${target} の読み取りに失敗しました: ${errorMessage(error)}`);
  }
}

function jsonState(context, target) {
  const raw = textState(context, target);
  if (raw.status !== 'present') return raw;
  try {
    return { status: 'present', value: JSON.parse(raw.content) };
  } catch (error) {
    return unknown(`${target} のJSON構文エラー: ${errorMessage(error)}`);
  }
}

function directoryState(context, target) {
  if (typeof context.capabilities.readdir !== 'function') {
    return unknown('readdir capability is unavailable');
  }
  try {
    return { status: 'present', entries: context.capabilities.readdir(target) };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return absent(target);
    return unknown(`${target} の列挙に失敗しました: ${errorMessage(error)}`);
  }
}

function entriesNames(entries) {
  return (entries || []).map((entry) => typeof entry === 'string' ? entry : entry.name);
}

function mergeResults(results, label) {
  const presentResult = results.find((result) => result.status === 'present');
  if (presentResult) return presentResult;
  const unknownResult = results.find((result) => result.status === 'unknown');
  if (unknownResult) return unknownResult;
  const notApplicableResult = results.find((result) => result.status === 'not_applicable');
  if (notApplicableResult) return notApplicableResult;
  return absent(label);
}

function checkRequiredCapabilities(entry, context) {
  const missing = [];
  for (const capability of entry.requiredCapabilities) {
    let available = true;
    if (capability === 'workspace-read') {
      available = Boolean(context.workspace)
        && typeof context.capabilities.lstat === 'function'
        && typeof context.capabilities.readdir === 'function'
        && typeof context.capabilities.readFile === 'function';
    } else if (capability === 'managed-read') {
      available = typeof context.managedRoot === 'string'
        && typeof context.capabilities.lstat === 'function'
        && typeof context.capabilities.readdir === 'function'
        && typeof context.capabilities.readFile === 'function';
    } else if (capability === 'runtime-read') {
      available = Boolean(context.workspace)
        && typeof context.runtimeRoot === 'string'
        && typeof context.capabilities.lstat === 'function'
        && typeof context.capabilities.readdir === 'function'
        && typeof context.capabilities.readFile === 'function';
    } else if (capability === 'git-ref-read') {
      available = Boolean(context.workspace) && typeof context.capabilities.readRef === 'function';
    } else if (capability === 'process-observation') {
      available = typeof context.capabilities.isProcessAlive === 'function';
    }
    if (!available) missing.push(capability);
  }
  return missing;
}

function unavailableResult(entry, context, missing) {
  if (!context.workspace && entry.requiredCapabilities.some((capability) => (
    capability === 'workspace-read' || capability === 'runtime-read'
  ))) {
    return notApplicable('workspace scope was not supplied');
  }
  return unknown(`必要な検査能力を利用できません: ${missing.join(', ')}`);
}

function observeProcess(context, pid, meta = null) {
  if (!Number.isInteger(pid) || pid <= 0) return { live: 'unknown', reason: 'PID is invalid' };
  try {
    const alive = context.capabilities.isProcessAlive(pid);
    if (typeof alive !== 'boolean') return { live: 'unknown', reason: '生存確認がbooleanを返しませんでした' };
    if (!alive) return { live: false };
    if (meta && typeof meta.startTime === 'string' && meta.startTime) {
      const identity = context.capabilities.verifyProcessIdentity(pid, meta);
      if (!identity || identity.match !== true) {
        return { live: 'unknown', reason: identity?.reason || 'プロセス同一性を確認できません' };
      }
    }
    return { live: true };
  } catch (error) {
    return { live: 'unknown', reason: errorMessage(error) };
  }
}

function observeResidentLease(context, role) {
  if (typeof context.capabilities.isResidentLeaseLive !== 'function') {
    return { live: 'unknown', reason: 'isResidentLeaseLive capability is unavailable' };
  }
  try {
    const live = context.capabilities.isResidentLeaseLive({ workspace: context.workspace, role });
    return typeof live === 'boolean'
      ? { live }
      : { live: 'unknown', reason: 'resident leaseの生存確認がbooleanを返しませんでした' };
  } catch (error) {
    return { live: 'unknown', reason: errorMessage(error) };
  }
}

function resolveHookLocations(context) {
  if (context.caches.has('hookLocations')) return context.caches.get('hookLocations');
  const unknownResult = (reason) => ({ status: 'unknown', reason });
  const config = context.capabilities.readGitConfig(context.workspace, 'core.hooksPath');
  if (!config || config.status === 'unknown') {
    const value = config?.reason || 'core.hooksPath の問い合わせに失敗しました';
    const result = unknownResult(value);
    context.caches.set('hookLocations', result);
    return result;
  }
  const gitDir = context.capabilities.readGitDir(context.workspace);
  if (!gitDir || gitDir.status !== 'ok' || !gitDir.value) {
    const result = unknownResult(gitDir?.reason || 'git-dir の問い合わせに失敗しました');
    context.caches.set('hookLocations', result);
    return result;
  }
  const defaultHooksDir = path.resolve(
    path.isAbsolute(gitDir.value) ? gitDir.value : path.join(context.workspace, gitDir.value),
    'hooks',
  );
  const effectiveHooksDir = config.status === 'ok' && config.value
    ? path.resolve(context.workspace, config.value)
    : defaultHooksDir;
  const result = { status: 'ok', defaultHooksDir, effectiveHooksDir };
  context.caches.set('hookLocations', result);
  return result;
}

function markerInFile(context, filePath, markerRe) {
  const state = textState(context, filePath);
  if (state.status !== 'present') return state;
  const found = state.content.split(/\r?\n/).some((line) => markerRe.test(line.trim()));
  return found ? present(filePath) : absent(filePath);
}

function detectAiReviewCi(context) {
  const sentinel = path.join(context.workspace, '.gh-maestro', 'ai-review-ok');
  const sentinelState = pathState(context, sentinel);
  if (sentinelState.status === 'unknown') return sentinelState;

  const refResults = [];
  for (const branch of LEGACY_REPOSITORY_REFS) {
    const ref = `refs/remotes/origin/${branch}`;
    for (const filePath of LEGACY_AI_REVIEW_PATHS) {
      const result = context.capabilities.readRef(context.workspace, ref, filePath);
      refResults.push({ branch, filePath, ...result });
    }
  }
  const found = refResults.filter((result) => result.status === 'present');
  if (sentinelState.status === 'present' || found.length > 0) {
    return present({ sentinel: sentinelState.status === 'present', files: found });
  }
  const unavailable = refResults.find((result) => result.status === 'unknown');
  if (unavailable) return unknown(unavailable.reason || '旧AIレビューCIのrefを確認できません');
  return absent('旧AIレビューCIのセンチネルとワークフローはありません');
}

function detectEffectiveHookMarker(context, hookName, markerRe) {
  const locations = resolveHookLocations(context);
  if (locations.status !== 'ok') return unknown(locations.reason);
  return markerInFile(context, path.join(locations.effectiveHooksDir, hookName), markerRe);
}

function detectStaleDefaultHooks(context) {
  const locations = resolveHookLocations(context);
  if (locations.status !== 'ok') return unknown(locations.reason);
  if (path.resolve(locations.defaultHooksDir).toLowerCase()
    === path.resolve(locations.effectiveHooksDir).toLowerCase()) {
    return absent('既定のhooks置き場が現在のhooks置き場です');
  }
  return mergeResults(
    ['pre-commit', 'pre-push'].map((hookName) => mergeResults([
      markerInFile(context, path.join(locations.defaultHooksDir, hookName), SYNC_RULES_MARKER_RE),
      markerInFile(context, path.join(locations.defaultHooksDir, hookName), CHECKS_MARKER_RE),
    ], hookName)),
    '既定hooks置き場にマーカーはありません',
  );
}

function detectLegacyGitIgnore(context) {
  const state = textState(context, path.join(context.workspace, '.gitignore'));
  if (state.status !== 'present') return state;
  return state.content.split(/\r?\n/).some((line) => line.trim() === '.gh-maestro/')
    ? present('.gitignore contains .gh-maestro/')
    : absent('.gitignore has no legacy .gh-maestro/ entry');
}

function detectManagedAgentsJson(context) {
  return jsonState(context, path.join(context.managedRoot, 'agents.json'));
}

function detectManagedEntries(context) {
  const state = directoryState(context, context.managedRoot);
  if (state.status !== 'present') return state;
  const names = new Set(entriesNames(state.entries));
  const found = LEGACY_MANAGED_ENTRIES.filter((name) => names.has(name));
  return found.length > 0 ? present(found) : absent('既知の旧管理項目はありません');
}

function detectLegacyHomePids(context) {
  return pathState(context, path.join(context.managedRoot, 'pids'));
}

function detectLegacyRecordDirectories(context) {
  return mergeResults(
    LEGACY_RECORD_DIRS.map((dir) => pathState(context, path.join(context.workspace, '.gh-maestro', dir))),
    '旧配置レコードのディレクトリはありません',
  );
}

function detectLegacyWorkspacePids(context) {
  return pathState(context, path.join(context.workspace, '.gh-maestro', 'pids'));
}

function detectV1State(context) {
  const directory = path.join(context.workspace, '.gh-maestro', 'msg-state');
  const state = directoryState(context, directory);
  if (state.status !== 'present') return state;
  const candidates = entriesNames(state.entries).filter((name) => name.endsWith('.json'));
  if (candidates.length === 0) return absent('v1形式のstateファイルはありません');

  const results = [];
  for (const fileName of candidates) {
    const self = fileName.slice(0, -'.json'.length);
    let result;
    try {
      const readResult = readState(context.workspace, self);
      if (readResult.status === 'legacy') {
        result = present(`${fileName}: legacy`);
      } else if (readResult.status === 'missing') {
        result = absent(`${fileName}: missing`);
      } else if (readResult.status === 'corrupt') {
        result = unknown(`${fileName}: corrupt state`);
      } else {
        result = absent(`${fileName}: current state`);
      }
    } catch (error) {
      result = unknown(`${fileName} のstate判定に失敗しました: ${errorMessage(error)}`);
    }
    results.push(result);
  }
  return mergeResults(results, 'v1形式のstateはありません');
}

function getWorkers(context) {
  if (context.caches.has('workers')) return context.caches.get('workers');
  if (typeof context.capabilities.readWorkers !== 'function') {
    const result = { status: 'unknown', reason: 'readWorkers capability is unavailable' };
    context.caches.set('workers', result);
    return result;
  }
  try {
    const value = context.capabilities.readWorkers(context.workspace);
    const result = value === null
      ? { status: 'absent', value: null }
      : value && typeof value === 'object' && !Array.isArray(value)
        ? { status: 'present', value }
        : { status: 'unknown', reason: 'workers.json is not an object' };
    context.caches.set('workers', result);
    return result;
  } catch (error) {
    const result = { status: 'unknown', reason: `workers.json の読み取りに失敗しました: ${errorMessage(error)}` };
    context.caches.set('workers', result);
    return result;
  }
}

function workerEntriesWithField(context, field) {
  const workers = getWorkers(context);
  if (workers.status !== 'present') return workers;
  const found = [];
  for (const [workerName, entry] of Object.entries(workers.value)) {
    if (workerName === 'orchestrator') continue;
    if (entry && typeof entry === 'object' && entry[field] != null && entry[field] !== '') {
      found.push({ workerName, entry });
    } else if (field === 'paneId' && (typeof entry === 'string' || typeof entry === 'number')) {
      found.push({ workerName, entry });
    }
  }
  return { status: 'present', value: found };
}

function detectDetachedNotifier(context) {
  const workers = workerEntriesWithField(context, 'notifierPid');
  if (workers.status !== 'present') return workers;
  if (workers.value.length === 0) return absent('旧detached notifierの記録はありません');
  const observations = [];
  for (const item of workers.value) {
    const pid = Number(item.entry.notifierPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      observations.push({ workerName: item.workerName, pid: item.entry.notifierPid, live: 'unknown' });
      continue;
    }
    // notifierPidはworkers.jsonのワーカー本体とは別プロセスのPIDなので、ワーカーの
    // startTimeをnotifierへ流用して同一性を照合してはならない。
    const observation = observeProcess(context, pid);
    observations.push({ workerName: item.workerName, pid, live: observation.live });
  }
  return present(observations);
}

function detectLegacyPane(context) {
  const workers = workerEntriesWithField(context, 'paneId');
  if (workers.status !== 'present') return workers;
  return workers.value.length > 0
    ? present(workers.value.map(({ workerName, entry }) => ({ workerName, paneId: entry.paneId ?? entry })))
    : absent('旧WezTerm paneIdの記録はありません');
}

function detectLegacyMessages(context) {
  return pathState(context, path.join(context.workspace, '.gh-maestro', 'messages'));
}

function detectLegacyQueue(context) {
  const queue = pathState(context, path.join(context.workspace, '.gh-maestro', 'queue'));
  if (queue.status !== 'present') return queue;
  const poller = jsonState(context, path.join(context.workspace, '.gh-maestro', 'queue', 'poller.json'));
  if (poller.status === 'unknown') return poller;
  if (poller.status === 'present' && poller.value && Number.isInteger(poller.value.pid)) {
    const observation = observeProcess(context, poller.value.pid, poller.value);
    return present({ queue: true, pollerPid: poller.value.pid, live: observation.live,
      ...(observation.reason ? { observationError: observation.reason } : {}) });
  }
  return present({ queue: true, poller: poller.status });
}

function runtimeWorkspacePath(context, ...parts) {
  if (typeof context.runtimeRoot !== 'string' || !context.workspace) return null;
  return path.join(context.runtimeRoot, 'workspaces', storageLayout.workspaceKey(context.workspace), ...parts);
}

function readJsonEntriesFromDirectory(context, directory) {
  const state = directoryState(context, directory);
  if (state.status !== 'present') return state;
  const results = [];
  for (const name of entriesNames(state.entries).filter((entry) => entry.endsWith('.json'))) {
    const item = jsonState(context, path.join(directory, name));
    results.push({ name, ...item });
  }
  return { status: 'present', entries: results };
}

function detectLegacySupervisorName(context) {
  const directories = [
    path.join(context.workspace, '.gh-maestro', 'pids'),
    runtimeWorkspacePath(context, 'pids'),
  ].filter(Boolean);
  const observations = [];
  let unknownReason = null;
  for (const directory of directories) {
    const files = readJsonEntriesFromDirectory(context, directory);
    if (files.status === 'unknown') unknownReason = files.reason;
    if (files.status !== 'present') continue;
    for (const item of files.entries) {
      if (item.status === 'unknown') {
        unknownReason = item.reason;
        continue;
      }
      if (item.status !== 'present' || !item.value || item.value.script !== LEGACY_SUPERVISOR_SCRIPT) continue;
      const observation = observeProcess(context, item.value.pid, item.value);
      const live = observation.live;
      if (observation.reason) unknownReason = observation.reason;
      observations.push({ source: path.join(directory, item.name), pid: item.value.pid ?? null, live });
    }
  }

  const leasePath = path.join(
    context.workspace,
    '.gh-maestro',
    'leases',
    `${workerLease.roleLeaseKey(LEGACY_SUPERVISOR_ROLE)}.json`,
  );
  const lease = jsonState(context, leasePath);
  if (lease.status === 'unknown') unknownReason = lease.reason;
  if (lease.status === 'present') {
    const observation = observeResidentLease(context, LEGACY_SUPERVISOR_ROLE);
    if (observation.reason) unknownReason = observation.reason;
    observations.push({ source: leasePath, role: LEGACY_SUPERVISOR_ROLE, live: observation.live });
  }
  if (observations.length > 0) return present(observations);
  return unknownReason ? unknown(unknownReason) : absent('旧supervisor名のPID/leaseはありません');
}

function detectTypoSupervisorLease(context) {
  const leasePath = path.join(
    context.workspace,
    '.gh-maestro',
    'leases',
    `${workerLease.roleLeaseKey(LEGACY_TYPO_SUPERVISOR_ROLE)}.json`,
  );
  const lease = jsonState(context, leasePath);
  if (lease.status !== 'present') return lease;
  const observation = observeResidentLease(context, LEGACY_TYPO_SUPERVISOR_ROLE);
  return present({ path: leasePath, role: LEGACY_TYPO_SUPERVISOR_ROLE, live: observation.live,
    ...(observation.reason ? { observationError: observation.reason } : {}) });
}

function isRolelessWorkerName(name, entry = null) {
  if (entry && typeof entry === 'object' && Number.isFinite(Number(entry.issue))
    && typeof entry.skill === 'string') {
    try {
      const role = deriveRoleFromSkill(entry.skill);
      const issuePrefix = `issue-${Number(entry.issue)}-`;
      if (name.startsWith(issuePrefix)) return !name.startsWith(`${issuePrefix}${role}-`);
    } catch { /* fallback to the established name shape below */ }
  }
  return LEGACY_ROLELESS_WORKER_RE.test(name);
}

function detectRolelessWorker(context) {
  const workers = getWorkers(context);
  if (workers.status === 'unknown') return workers;
  const observations = [];
  if (workers.status === 'present') {
    for (const [workerName, entry] of Object.entries(workers.value)) {
      if (!isRolelessWorkerName(workerName, entry)) continue;
      let live = 'unknown';
      try { live = context.capabilities.isWorkerAlive(entry); } catch { /* field presence remains known */ }
      observations.push({ source: 'workers.json', workerName, live });
    }
  }

  const leasesPath = path.join(context.workspace, '.gh-maestro', 'leases');
  const leases = readJsonEntriesFromDirectory(context, leasesPath);
  if (leases.status === 'unknown') return leases;
  if (leases.status === 'present') {
    for (const item of leases.entries) {
      if (item.status === 'unknown') return unknown(item.reason);
      const workerName = item.value?.workerName || item.name.replace(/\.json$/, '');
      if (!isRolelessWorkerName(workerName, item.value)) continue;
      let live = 'unknown';
      try { live = context.capabilities.isLeaseLive(item.value); } catch { /* state is still present */ }
      observations.push({ source: 'leases', workerName, live });
    }
  }
  return observations.length > 0
    ? present(observations)
    : absent('role無し旧形式ワーカーの記録はありません');
}

const DETECTORS = Object.freeze({
  'setup-ai-review-ci': detectAiReviewCi,
  'setup-pre-commit-checks-hook': (context) => detectEffectiveHookMarker(context, 'pre-commit', CHECKS_MARKER_RE),
  'setup-pre-push-checks-hook': (context) => detectEffectiveHookMarker(context, 'pre-push', CHECKS_MARKER_RE),
  'setup-stale-default-hooks': detectStaleDefaultHooks,
  'setup-legacy-gitignore': detectLegacyGitIgnore,
  'install-legacy-agents-config': detectManagedAgentsJson,
  'install-legacy-home-pids': detectLegacyHomePids,
  'install-legacy-managed-items': detectManagedEntries,
  'migrate-legacy-records': detectLegacyRecordDirectories,
  'process-legacy-pid-registry': detectLegacyWorkspacePids,
  'msg-poll-v1-state': detectV1State,
  'reset-detached-notifier': detectDetachedNotifier,
  'reset-legacy-wezterm-pane': detectLegacyPane,
  'reset-legacy-messages': detectLegacyMessages,
  'reset-legacy-queue': detectLegacyQueue,
  'stop-worker-legacy-pane': detectLegacyPane,
  'worker-supervisor-legacy-name': detectLegacySupervisorName,
  'restart-residents-legacy-lease': detectTypoSupervisorLease,
  'spawn-worker-roleless-worker': detectRolelessWorker,
});

function inspectLegacyArtifacts(options = {}) {
  const context = createContext(options);
  const catalog = options.catalog || CATALOG;
  const detectors = options.detectors || DETECTORS;
  const items = [];
  let complete = true;

  for (const entry of catalog) {
    const detector = detectors[entry.id];
    let result;
    if (typeof detector !== 'function') {
      complete = false;
      result = unknown(`detector が登録されていません: ${entry.id}`);
    } else {
      const missing = checkRequiredCapabilities(entry, context);
      if (missing.length > 0) {
        result = unavailableResult(entry, context, missing);
      } else {
        try {
          result = detector(context);
        } catch (error) {
          result = unknown(`detector ${entry.id} の実行に失敗しました: ${errorMessage(error)}`);
        }
      }
    }
    if (!ITEM_STATES.includes(result?.status)) {
      complete = false;
      result = unknown(`detector ${entry.id} が不正な状態を返しました`);
    }
    items.push({
      ...entry,
      ...result,
    });
  }

  const counts = Object.fromEntries(ITEM_STATES.map((state) => [state, 0]));
  for (const item of items) counts[item.status]++;
  return {
    schemaVersion: 1,
    expectedItemCount: catalog === CATALOG ? DECLARATION.expectedItemCount : catalog.length,
    completeness: complete ? 'complete' : 'incomplete',
    counts,
    items,
  };
}

function hasLegacyFindings(result) {
  return result.completeness === 'incomplete'
    || result.items.some((item) => item.status === 'present' || item.status === 'unknown');
}

module.exports = {
  CATALOG,
  DECLARATION,
  DETECTORS,
  ITEM_STATES,
  COMPLETENESS_STATES,
  validateCatalogDeclaration,
  inspectLegacyArtifacts,
  hasLegacyFindings,
};
