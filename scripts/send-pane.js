#!/usr/bin/env node
// Usage: node send-pane.js <worker-name> <message> [--workspace <path>]
//
// send-pane.js は、メッセージをファイルシステムキューに enqueue し、poller による
// WezTerm 通知を任せる薄いラッパーである。Phase 4 移行により、従来の WezTerm 入力注入
// 直接呼び出しから enqueue 主体へ切り替わった。
//
// exit 0 = enqueue 成功（配送成功ではない）。ack だけが配送成功の根拠。
//
// worker-name は .gh-maestro/workers.json で pane-id に解決されていたが、
// enqueue 移行後はそのままキューの recipient 名として使われる。
// "orchestrator" を指定すると orchestrator の inbox に enqueue する。
//
// 送信方向に応じて送信者名がメッセージ本文先頭に自動付与される（後方互換）。
//
// workspace の解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索

'use strict';

const os = require('os');
const path = require('path');
const { readFileSync, existsSync } = require('fs');
const { spawn } = require('child_process');
const { normalizeWorkerEntry } = require('./worker-entry');
const { enqueue } = require('./queue');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { acquirePollerLease } = require('./queue-poller');

const USAGE = `send-pane.js — メッセージをファイルシステムキューに送信する（後方互換ラッパー）

Usage: node send-pane.js <worker-name> <message> [--workspace <path>]

Arguments:
  <worker-name>       送信先ワーカー名（"orchestrator" で orchestrator の inbox）
  <message>           送信するメッセージ（残りの引数を連結）
  --workspace <path>  ワークスペース（省略時: GH_MAESTRO_WORKSPACE env > CWD から上方探索）

内部的には queue-send.js と同様に enqueue を行い、poller が pane 通知を担当する。
exit 0 は「enqueue 成功」であり配送成功ではない。ack だけが配送成功の根拠。`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const { values, rest, exitFlagMiss } = parseFlags(args, ['--workspace']);

if (exitFlagMiss) {
  console.error('send-pane: --workspace には値が必要です。');
  console.error(USAGE);
  process.exit(1);
}

const [name, ...msgParts] = rest;
const message = msgParts.join(' ');

if (!name || !message) {
  console.error(USAGE);
  process.exit(1);
}

const workspace = resolveWorkspace(values['--workspace']);
if (!workspace) {
  console.error('send-pane: ワークスペースを解決できません。');
  process.exit(1);
}

// 送信者を逆引き: 現在のpane-idがworkersのどのエントリか
let senderName = null;
const workersJson = path.resolve(workspace, '.gh-maestro', 'workers.json');
if (existsSync(workersJson)) {
  try {
    const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
    const myPaneId = String(process.env.WEZTERM_PANE ?? '');
    if (myPaneId) {
      for (const [k, v] of Object.entries(workers)) {
        if (normalizeWorkerEntry(v).paneId === myPaneId) { senderName = k; break; }
      }
    }
  } catch {
    // workers.json 破損時は senderName なしで続行
  }
}

// 送信者名をメッセージ先頭に付与（後方互換: 従来のsend-paneと同じプレフィックス）
const prefix = senderName === 'orchestrator'
  ? 'orchestratorです。'
  : senderName ? `${senderName}担当workerです。` : '';

const fullBody = prefix + message;

// from: 検出できた送信者名を優先、なければ GH_MAESTRO_WORKER env、最後にデフォルト
const from = senderName || process.env.GH_MAESTRO_WORKER || 'orchestrator';

// ── enqueue ────────────────────────────────────────────────────────────────

try {
  const result = enqueue(workspace, {
    to: name,
    from,
    body: fullBody,
  });
  console.log(result.messageId);

  // ── lazy-start: poller が起動していなければ起動する ────────────────────
  // GH_MAESTRO_DISABLE_LAZY_POLLER=1 でゲート（テスト用）

  if (!process.env.GH_MAESTRO_DISABLE_LAZY_POLLER) {
    const pollerScript = path.join(__dirname, 'queue-poller.js');

    // acquirePollerLease（queue-poller.js と共用）で lease 取得を試みる
    const placeholderPayload = JSON.stringify({
      pid: 0, // プレースホルダー — claimPoller が即乗っ取る
      heartbeat: Date.now(),
      startedAt: new Date().toISOString(),
    });
    const acquired = acquirePollerLease(workspace, placeholderPayload);

    if (acquired) {
      const child = spawn(process.execPath, [pollerScript, '--workspace', workspace], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    }
  }

  process.exit(0);
} catch (err) {
  console.error(`send-pane: enqueue に失敗しました: ${err.message}`);
  process.exit(1);
}
