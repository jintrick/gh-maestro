'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const migrateRecords = require('../scripts/migrate-records');
const { planMigration } = migrateRecords;
const inboxSupervisorControl = require('../scripts/shared/inbox-supervisor-control');
const { findRunningInstance } = require('../scripts/process-lifecycle');
const { killProcessTree } = require('../scripts/kill-tree');
const workerLease = require('../scripts/shared/worker-lease');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-migrate-records-'));
  fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
  return dir;
}

// inbox-supervisor-control の注入（_set...）はモジュール内のモジュール変数を書き換えるため、
// テスト間で実装を跨いで持ち越さないよう、各テスト後に必ず実装へ戻す。
test.afterEach(() => {
  inboxSupervisorControl._setFindRunningInstance(findRunningInstance);
  inboxSupervisorControl._setCreateResidentLeaseStore(workerLease.createResidentLeaseStore);
  inboxSupervisorControl._setIsLeaseLive(workerLease.isLeaseLive);
  inboxSupervisorControl._setKillProcessTree(killProcessTree);
});

test('migration is dry-run safe and then idempotent', () => {
  const dir = workspace();
  const oldLog = path.join(dir, '.gh-maestro', 'worker-logs', 'issue-5-coder-fix.log');
  const oldWatch = path.join(dir, '.gh-maestro', 'assistant-watch', '5.json');
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.mkdirSync(path.dirname(oldWatch), { recursive: true });
  fs.writeFileSync(oldLog, 'log\n');
  fs.writeFileSync(oldWatch, '{"prs":{}}');

  const preview = planMigration(dir, 'all', { dryRun: true });
  assert.equal(preview.moved.length, 2);
  assert.equal(fs.existsSync(oldLog), true);
  assert.equal(fs.existsSync(oldWatch), true);

  const applied = planMigration(dir, 'all');
  assert.equal(applied.moved.length, 2);
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(oldWatch), false);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-coder-fix', 'worker.log')), true);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'assistant-watch.json')), true);

  const rerun = planMigration(dir, 'all');
  assert.equal(rerun.moved.length, 0);
  assert.equal(rerun.alreadyMigrated.length, 0);
});

test('migration reports differing destination content as a conflict without overwrite', () => {
  const dir = workspace();
  const oldLog = path.join(dir, '.gh-maestro', 'worker-logs', 'issue-5-coder-fix.log');
  const destination = path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-coder-fix', 'worker.log');
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(oldLog, 'old');
  fs.writeFileSync(destination, 'new');

  const result = planMigration(dir, 'worker-log');
  assert.equal(result.conflicts.length, 1);
  assert.equal(fs.readFileSync(oldLog, 'utf8'), 'old');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'new');
});

test('migration holds a worker log owned by a live workers.json process', () => {
  const dir = workspace();
  const workerName = 'issue-5-coder-fix';
  const oldLog = path.join(dir, '.gh-maestro', 'worker-logs', `${workerName}.log`);
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, 'live\n');
  fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), JSON.stringify({
    [workerName]: { pid: process.pid },
  }));

  const result = planMigration(dir, 'worker-log', { dryRun: true });
  assert.equal(result.held.length, 1);
  assert.equal(result.moved.length, 0);
  assert.equal(fs.existsSync(oldLog), true);
});

test('migration holds a worker log when workers.json is unreadable（破損時は held に倒れる）', () => {
  const dir = workspace();
  const workerName = 'issue-5-coder-fix';
  const oldLog = path.join(dir, '.gh-maestro', 'worker-logs', `${workerName}.log`);
  fs.mkdirSync(path.dirname(oldLog), { recursive: true });
  fs.writeFileSync(oldLog, 'live\n');
  // workers.json を解析不能にする。readWorkersRaw は throw し、ownerIsLive の既存の catch が
  // 「生存を判定できない」ことを held（true）に倒す（Issue #275 項目1）。破損を「非生存」と
  // 誤判定すると移行対象が動いてしまい、稼働中ワーカーのログを引き剥がす。
  fs.writeFileSync(path.join(dir, '.gh-maestro', 'workers.json'), '{ broken json');

  const result = planMigration(dir, 'worker-log', { dryRun: true });
  assert.equal(result.held.length, 1);
  assert.equal(result.moved.length, 0);
  assert.equal(fs.existsSync(oldLog), true);
});

test('migration classifies inbox-supervisor cursors vs contracts by their directory', () => {
  const dir = workspace();
  const oldCursor = path.join(dir, '.gh-maestro', 'inbox-supervisor', 'cursors', 'issue-5-coder-fix.json');
  const oldContract = path.join(dir, '.gh-maestro', 'inbox-supervisor', 'contracts', 'issue-5-coder-fix.json');
  fs.mkdirSync(path.dirname(oldCursor), { recursive: true });
  fs.mkdirSync(path.dirname(oldContract), { recursive: true });
  fs.writeFileSync(oldCursor, '{"cursor":1}');
  fs.writeFileSync(oldContract, '{"contract":1}');

  const preview = planMigration(dir, 'inbox-supervisor', { dryRun: true });
  assert.equal(preview.moved.length, 2);
  const cursorDest = preview.moved.find((m) => m.source === oldCursor).destination;
  const contractDest = preview.moved.find((m) => m.source === oldContract).destination;
  assert.equal(cursorDest.endsWith(path.join('workers', 'issue-5-coder-fix', 'cursor.json')), true);
  assert.equal(contractDest.endsWith(path.join('workers', 'issue-5-coder-fix', 'contract.json')), true);

  const applied = planMigration(dir, 'inbox-supervisor');
  assert.equal(applied.moved.length, 2);
  assert.equal(fs.existsSync(oldCursor), false);
  assert.equal(fs.existsSync(oldContract), false);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-coder-fix', 'cursor.json')), true);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', 'records', 'issue', '5', 'workers', 'issue-5-coder-fix', 'contract.json')), true);
});

test('migration holds an assistant-watch record whose issue has a registered assistant（対話型assistantは強制終了しない）', () => {
  const dir = workspace();
  const oldWatch = path.join(dir, '.gh-maestro', 'assistant-watch', '5.json');
  fs.mkdirSync(path.dirname(oldWatch), { recursive: true });
  fs.writeFileSync(oldWatch, '{"prs":{}}');
  fs.writeFileSync(path.join(dir, '.gh-maestro', 'assistants.json'), JSON.stringify({
    '5': { paneId: 'pane-5', launchedAt: '2026-08-01T00:00:00.000Z' },
  }));

  const preview = planMigration(dir, 'assistant-watch', { dryRun: true });
  assert.equal(preview.held.length, 1);
  assert.equal(preview.held[0].reason, 'assistant agent is running');
  assert.equal(preview.moved.length, 0);
  assert.equal(fs.existsSync(oldWatch), true);

  // 実実行でも held のまま移動しない
  const applied = planMigration(dir, 'assistant-watch');
  assert.equal(applied.held.length, 1);
  assert.equal(applied.moved.length, 0);
  assert.equal(fs.existsSync(oldWatch), true);
});

test('migration moves an assistant-watch record when the assistant is not registered', () => {
  const dir = workspace();
  const oldWatch = path.join(dir, '.gh-maestro', 'assistant-watch', '7.json');
  fs.mkdirSync(path.dirname(oldWatch), { recursive: true });
  fs.writeFileSync(oldWatch, '{"prs":{}}');
  // assistants.json は存在しない → getAssistant は null → held にならない

  const result = planMigration(dir, 'assistant-watch');
  assert.equal(result.moved.length, 1);
  assert.equal(result.held.length, 0);
  assert.equal(fs.existsSync(oldWatch), false);
});

test('shouldControlInboxSupervisor: all / inbox-supervisor のみ制御対象', () => {
  assert.equal(migrateRecords.shouldControlInboxSupervisor('all'), true);
  assert.equal(migrateRecords.shouldControlInboxSupervisor('inbox-supervisor'), true);
  assert.equal(migrateRecords.shouldControlInboxSupervisor('worker-log'), false);
  assert.equal(migrateRecords.shouldControlInboxSupervisor('review-manager'), false);
  assert.equal(migrateRecords.shouldControlInboxSupervisor('assistant-watch'), false);
});

test('runWithInboxSupervisorControl: 実実行はマーカーを作成し、移行中のみ存在、完了後は削除され、稼働中supervisorを停止する', () => {
  const dir = workspace();
  inboxSupervisorControl._setFindRunningInstance(() => ({ pid: 4242, script: 'inbox-supervisor.js' }));
  inboxSupervisorControl._setCreateResidentLeaseStore(() => ({ read: () => null }));
  inboxSupervisorControl._setIsLeaseLive(() => false);
  const killed = [];
  inboxSupervisorControl._setKillProcessTree((pid) => { killed.push(pid); });

  let markerSeenDuringFn = false;
  let notice = null;
  const ret = migrateRecords.runWithInboxSupervisorControl(dir, 'inbox-supervisor', { dryRun: false }, (n) => {
    notice = n;
    markerSeenDuringFn = fs.existsSync(path.join(dir, '.gh-maestro', '.migration-in-progress'));
    return 'done';
  });

  assert.equal(ret, 'done');
  assert.equal(markerSeenDuringFn, true, '移行実行中はマーカーが存在する');
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', '.migration-in-progress')), false, '完了後はマーカーが残らない');
  assert.deepEqual(killed, [4242]);
  assert.match(notice, /停止しました/);
});

test('runWithInboxSupervisorControl: --dry-run は停止もマーカー作成も行わず、notice で「実実行時に停止」と伝える', () => {
  const dir = workspace();
  inboxSupervisorControl._setFindRunningInstance(() => ({ pid: 4242, script: 'inbox-supervisor.js' }));
  inboxSupervisorControl._setCreateResidentLeaseStore(() => ({ read: () => null }));
  inboxSupervisorControl._setIsLeaseLive(() => false);
  let killed = false;
  inboxSupervisorControl._setKillProcessTree(() => { killed = true; });

  let markerSeenDuringFn = false;
  let notice = null;
  migrateRecords.runWithInboxSupervisorControl(dir, 'inbox-supervisor', { dryRun: true }, (n) => {
    notice = n;
    markerSeenDuringFn = fs.existsSync(path.join(dir, '.gh-maestro', '.migration-in-progress'));
    return null;
  });

  assert.equal(killed, false);
  assert.equal(markerSeenDuringFn, false);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', '.migration-in-progress')), false);
  assert.match(notice, /実実行時に停止/);
});

test('runWithInboxSupervisorControl: 対象外scopeは制御せず素通し（マーカーも停止もなし）', () => {
  const dir = workspace();
  let notice = 'unset';
  const ret = migrateRecords.runWithInboxSupervisorControl(dir, 'assistant-watch', { dryRun: false }, (n) => {
    notice = n;
    return 'plain';
  });

  assert.equal(ret, 'plain');
  assert.equal(notice, null);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', '.migration-in-progress')), false);
});

test('main: --scope inbox-supervisor 実実行はexit 0でマーカーを残さない', () => {
  const dir = workspace();
  // テスト環境では「稼働中のsupervisorなし」として扱う（実プロセス検知・停止をさせない）
  inboxSupervisorControl._setFindRunningInstance(() => null);
  inboxSupervisorControl._setCreateResidentLeaseStore(() => ({ read: () => null }));
  inboxSupervisorControl._setIsLeaseLive(() => false);
  inboxSupervisorControl._setKillProcessTree(() => {});

  // GH_MAESTRO_WORKSPACE が設定されていると resolveWorkspace が引数を無視するため、
  // テスト実行環境の env から一時的に外して確実に --workspace を尊重させる。
  const savedEnv = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  let code;
  try {
    code = migrateRecords.main(['--workspace', dir, '--scope', 'inbox-supervisor']);
  } finally {
    if (savedEnv === undefined) delete process.env.GH_MAESTRO_WORKSPACE;
    else process.env.GH_MAESTRO_WORKSPACE = savedEnv;
  }

  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(dir, '.gh-maestro', '.migration-in-progress')), false);
});
