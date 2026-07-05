'use strict';
// pane-notify.js — pane 解決・cwd 検証・pane ロック・Enter 送出の共有モジュール
//
// send-pane.js から pane 関連操作を抽出したもの。poller と send-pane.js の両方が使う。
//
// Usage (CLI):
//   node pane-notify.js <worker-name> <message> [--workspace <path>]
//   node pane-notify.js --help
//
// Require:
//   const { notifyPane } = require('./pane-notify');

const path = require('path');
const { existsSync, readFileSync } = require('fs');
const { sendEnter } = require('./send-enter');
const { normalizeWorkerEntry } = require('./worker-entry');
const { resolveAgentConfig } = require('./resolve-agent');
const { withPaneLock } = require('./pane-lock');
const { resolveWorkspace } = require('./shared/workspace');
const { weztermCli } = require('./wezterm-cli');

const USAGE = `pane-notify.js — 起動中のワーカー/orchestrator のペインにメッセージを送る（共有モジュール）

Usage: node pane-notify.js <worker-name> <message> [--workspace <path>]

Arguments:
  <worker-name>       送信先ワーカー名（"orchestrator" で orchestrator ペイン）
  <message>           送信するメッセージ
  --workspace <path>  ワークスペース（省略時: GH_MAESTRO_WORKSPACE env > CWD から上方探索）

worker-name は .gh-maestro/workers.json で pane-id に解決される。`;

// ── CLI エントリ ──────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const wsIdx = args.indexOf('--workspace');
  const workspaceArg = (wsIdx !== -1 && args[wsIdx + 1]) ? args[wsIdx + 1] : null;
  const rest = args.filter((_, i) => i !== wsIdx && i !== wsIdx + 1);
  const [name, ...msgParts] = rest;
  const message = msgParts.join(' ');

  if (!name || !message) {
    console.error(USAGE);
    process.exit(1);
  }

  const workspace = resolveWorkspace(workspaceArg);
  if (!workspace) {
    console.error('pane-notify: ワークスペースを解決できません。');
    process.exit(1);
  }

  const ok = notifyPane(workspace, name, message);
  process.exit(ok ? 0 : 1);
}

/**
 * 指定 worker の pane を解決・検証し、メッセージを送信する。
 *
 * @param {string} workspace  絶対パス
 * @param {string} name       worker 名（"orchestrator" 可）
 * @param {string} message    送信内容
 * @returns {boolean} 送信成功時 true
 */
function notifyPane(workspace, name, message) {
  const workersJson = path.resolve(workspace, '.gh-maestro', 'workers.json');

  // ── pane 解決 ──────────────────────────────────────────────────────

  let paneId = name;
  let targetAgentId = null;

  if (existsSync(workersJson)) {
    const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
    if (workers[name]) {
      const entry = normalizeWorkerEntry(workers[name]);
      paneId = entry.paneId;
      targetAgentId = entry.agentId;
    }
  }

  // ── pane 実在 & cwd 検証 ───────────────────────────────────────────

  const expectedCwd = name === 'orchestrator'
    ? workspace
    : path.resolve(workspace, '.gh-maestro', 'worktrees', name);

  const listResult = weztermCli('cli', 'list', '--format', 'json');
  if (listResult.status !== 0) {
    process.stderr.write(`pane-notify: wezterm cli list 失敗 (exit ${listResult.status}): ${listResult.stderr?.trim()}\n`);
    return false;
  }

  let panes;
  try { panes = JSON.parse(listResult.stdout); } catch {
    process.stderr.write('pane-notify: wezterm cli list の出力パース失敗\n');
    return false;
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
      .replace(/^\/([a-zA-Z]:)/, '$1')
      .replace(/\/$/, '')
      .replace(/\\/g, '/');
  }
  function cwdMatches(p) {
    return normalizeCwd(p.cwd || '') === normalizedExpected;
  }

  // 1. pane_id で検索
  let target = panes.find(p => String(p.pane_id) === String(paneId));
  if (target && cwdMatches(target)) {
    // 一致 → OK
  } else {
    if (target) {
      process.stderr.write(`pane-notify: pane_id ${paneId} の cwd が期待と異なります（再利用の可能性）。cwd で再検索します。\n`);
    }
    // 2. cwd で全ペイン検索
    const byCwd = panes.find(p => cwdMatches(p));
    if (byCwd) {
      process.stderr.write(`pane-notify: cwd 一致するペインを発見: pane_id ${paneId} → ${byCwd.pane_id}\n`);
      paneId = String(byCwd.pane_id);
    } else {
      process.stderr.write(`pane-notify: ${name} のペインが見つかりません（pane_id=${paneId}, cwd=${normalizedExpected}）\n`);
      return false;
    }
  }

  // ── 送信 ───────────────────────────────────────────────────────────

  function sendText(targetPaneId, text) {
    const flat = text.replace(/\n+/g, ' ');
    const sendResult = weztermCli('cli', 'send-text', '--pane-id', targetPaneId, '--no-paste', flat);
    if (sendResult.status !== 0) {
      process.stderr.write(`pane-notify: wezterm send-text failed (exit ${sendResult.status}): ${sendResult.stderr?.trim()}\n`);
      return false;
    }
    const terminator = resolveAgentConfig(targetAgentId)?.enterSequence;
    sendEnter(targetPaneId, { send: weztermCli, terminator });
    return true;
  }

  // 同一paneへの並行送信を防止するため、pane単位でロックしてから送信
  const lockDir = path.join(workspace, '.gh-maestro', 'locks');
  const lockKey = String(paneId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return withPaneLock(lockDir, lockKey, 15000, () => sendText(paneId, message));
}

module.exports = { notifyPane };
