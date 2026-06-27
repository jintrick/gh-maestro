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

(function verifyPane() {
  const listResult = spawnSync('wezterm', ['cli', 'list', '--format', 'json'], { encoding: 'utf8' });
  if (listResult.status !== 0) {
    process.stderr.write(`send-pane: wezterm cli list 失敗 (exit ${listResult.status}): ${listResult.stderr?.trim()}\n`);
    process.exit(1);
  }
  let panes;
  try { panes = JSON.parse(listResult.stdout); } catch {
    process.stderr.write(`send-pane: wezterm cli list の出力パース失敗\n`);
    process.exit(1);
  }
  const target = panes.find(p => String(p.pane_id) === String(paneId));
  if (!target) {
    process.stderr.write(`send-pane: pane_id ${paneId} (${name}) は存在しません — ペインが死んでいる可能性があります\n`);
    process.exit(1);
  }
  const rawCwd = target.cwd || '';
  let actualCwd;
  // WezTerm の cwd は file:// URI。Node の URL でパースして OS 差を吸収する。
  try {
    actualCwd = decodeURIComponent(new URL(rawCwd).pathname).replace(/\/$/, '');
  } catch {
    // パース失敗時は単純な prefix 除去にフォールバック
    actualCwd = decodeURIComponent(rawCwd.replace(/^file:\/+/, '/')).replace(/\/$/, '');
  }
  const normalizedActual = actualCwd.replace(/\\/g, '/');
  const normalizedExpected = expectedCwd.replace(/\\/g, '/');
  if (normalizedActual !== normalizedExpected) {
    process.stderr.write(`send-pane: pane_id ${paneId} の cwd が期待と異なります:\n  期待: ${normalizedExpected}\n  実際: ${normalizedActual}\n  別の WezTerm インスタンスに接続している可能性があります\n`);
    process.exit(1);
  }
})();

// 送信者名をメッセージ先頭に付与
const prefix = senderName === 'orchestrator'
  ? 'orchestratorです。'
  : senderName ? `${senderName}担当workerです。` : '';

// ── 送信 ────────────────────────────────────────────────────────────────
// cwd 検証済みなので送信+Enterのワンショット。get-text による確認ポーリングは
// エージェントが応答生成中で echo しないと偽の失敗になるため撤廃。

const WEZ_TIMEOUT_MS = 6000;
function wez(...a) {
  return spawnSync('wezterm', a, { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS });
}

const flatMessage = (prefix + message).replace(/\n+/g, ' ');
const sendResult = wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', flatMessage);
if (sendResult.status !== 0) {
  process.stderr.write(`send-pane: wezterm send-text failed (exit ${sendResult.status}): ${sendResult.stderr?.trim()}\n`);
  process.exit(1);
}
wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
process.exit(0);
