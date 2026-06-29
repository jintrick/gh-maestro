#!/usr/bin/env node
// Usage: node send-pane.js <worker-name> <message> [--workspace <path>]
//
// worker-name は .gh-maestro/workers.json で pane-id に解決される。
// "orchestrator" を指定するとorchestratorペインに送信する。
// 送信方向に応じて送信者名を自動的にメッセージ先頭に付与する。
//
// workspace の解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索

const path = require('path');
const { spawnSync } = require('child_process');
const { readFileSync, existsSync } = require('fs');

const args = process.argv.slice(2);
const wsIdx = args.indexOf('--workspace');
const workspaceArg = (wsIdx !== -1 && args[wsIdx + 1]) ? args[wsIdx + 1] : null;

// --workspace とその値を除いた残りを解析
const rest = args.filter((_, i) => i !== wsIdx && i !== wsIdx + 1);
const [name, ...msgParts] = rest;
const message = msgParts.join(' ');

if (!name || !message) {
  console.error('Usage: send-pane.js <worker-name> <message>');
  process.exit(1);
}

// CWD から上方に遡って .gh-maestro/workers.json を探す
function findWorkspaceFromCwd() {
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.gh-maestro', 'workers.json');
    if (existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const workspace = process.env.GH_MAESTRO_WORKSPACE || workspaceArg || findWorkspaceFromCwd();

// workers.json のパスを解決
const workersJson = workspace
  ? path.resolve(workspace, '.gh-maestro', 'workers.json')
  : null;

let paneId = name;
let senderName = null;

if (workersJson && existsSync(workersJson)) {
  const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
  if (workers[name]) paneId = workers[name];

  // 送信者を逆引き: 現在のpane-idがworkersのどのエントリか
  const myPaneId = String(process.env.WEZTERM_PANE ?? '');
  if (myPaneId) {
    for (const [k, v] of Object.entries(workers)) {
      if (String(v) === myPaneId) { senderName = k; break; }
    }
  }
}

// ── pane の実在 & cwd 検証 ───────────────────────────────────────────

const expectedCwd = name === 'orchestrator'
  ? workspace
  : path.resolve(workspace, '.gh-maestro', 'worktrees', name);

const WEZ_TIMEOUT_MS = 6000;
// WEZTERM_MOCK: テスト専用の差し替え口。node で実行するモックスクリプトのパスを指定する。
// 本番では未設定なので実際の wezterm バイナリを呼ぶ。
const WEZTERM_MOCK = process.env.WEZTERM_MOCK || null;
function wez(...a) {
  return WEZTERM_MOCK
    ? spawnSync(process.execPath, [WEZTERM_MOCK, ...a], { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS })
    : spawnSync('wezterm', a, { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS });
}

(function verifyPane() {
  const listResult = wez('cli', 'list', '--format', 'json');
  if (listResult.status !== 0) {
    process.stderr.write(`send-pane: wezterm cli list 失敗 (exit ${listResult.status}): ${listResult.stderr?.trim()}\n`);
    process.exit(1);
  }
  let panes;
  try { panes = JSON.parse(listResult.stdout); } catch {
    process.stderr.write(`send-pane: wezterm cli list の出力パース失敗\n`);
    process.exit(1);
  }

  const normalizedExpected = expectedCwd.replace(/\\/g, '/');
  function normalizeCwd(raw) {
    let p;
    try {
      p = decodeURIComponent(new URL(raw).pathname);
    } catch {
      p = decodeURIComponent(raw.replace(/^file:\/+/, '/'));
    }
    return p
      .replace(/^\/([a-zA-Z]:)/, '$1')  // /C:/... → C:/...（非Windowsの /home/... は無変化）
      .replace(/\/$/, '')
      .replace(/\\/g, '/');
  }
  function cwdMatches(p) {
    return normalizeCwd(p.cwd || '') === normalizedExpected;
  }

  // 1. pane_id で検索
  let target = panes.find(p => String(p.pane_id) === String(paneId));
  if (target && cwdMatches(target)) {
    // pane_id も cwd も一致 → OK
    return;
  }

  // 2. pane_id は見つかったが cwd が不一致 → pane_id が別ペインに再利用された可能性
  if (target) {
    process.stderr.write(`send-pane: pane_id ${paneId} の cwd が期待と異なります（再利用の可能性）。cwd で再検索します。\n`);
  }

  // 3. cwd で全ペインを検索
  const byCwd = panes.find(p => cwdMatches(p));
  if (byCwd) {
    process.stderr.write(`send-pane: cwd 一致するペインを発見: pane_id ${paneId} → ${byCwd.pane_id}\n`);
    paneId = String(byCwd.pane_id);
    return;
  }

  process.stderr.write(`send-pane: ${name} のペインが見つかりません（pane_id=${paneId}, cwd=${normalizedExpected}）\n`);
  process.exit(1);
})();

// 送信者名をメッセージ先頭に付与
const prefix = senderName === 'orchestrator'
  ? 'orchestratorです。'
  : senderName ? `${senderName}担当workerです。` : '';

// ── 送信 ────────────────────────────────────────────────────────────────

const flatMessage = (prefix + message).replace(/\n+/g, ' ');
const sendResult = wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', flatMessage);
if (sendResult.status !== 0) {
  process.stderr.write(`send-pane: wezterm send-text failed (exit ${sendResult.status}): ${sendResult.stderr?.trim()}\n`);
  process.exit(1);
}
wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
process.exit(0);
