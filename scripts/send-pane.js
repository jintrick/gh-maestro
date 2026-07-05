#!/usr/bin/env node
// Usage: node send-pane.js <worker-name> <message> [--workspace <path>]
//
// worker-name は .gh-maestro/workers.json で pane-id に解決される。
// "orchestrator" を指定するとorchestratorペインに送信する。
// 送信方向に応じて送信者名を自動的にメッセージ先頭に付与する。
//
// <message> はキーストローク注入せず .gh-maestro/messages/ にファイルとして書き出し、
// pane には「このファイルを読んでください」という固定テンプレートの短文だけを送る。
// これは本文中の特殊文字（"@" 等）がEnterキー入力を消費し、メッセージが未送信のまま
// composerに残る問題を構造的に避けるため（詳細は message-file.js のコメント参照）。
//
// pane 解決・cwd 検証・pane ロック・Enter 送出は共有モジュール pane-notify.js に委譲。
//
// workspace の解決順: GH_MAESTRO_WORKSPACE env > --workspace 引数 > CWD から上方探索

const os = require('os');
const path = require('path');
const { readFileSync, existsSync } = require('fs');
const { normalizeWorkerEntry } = require('./worker-entry');
const { writeMessageFile, pruneOldMessageFiles } = require('./message-file');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { notifyPane } = require('./pane-notify');

const USAGE = `send-pane.js — 起動中のワーカー/orchestrator のペインにメッセージを送る

Usage: node send-pane.js <worker-name> <message> [--workspace <path>]

Arguments:
  <worker-name>       送信先ワーカー名（"orchestrator" で orchestrator ペイン）
  <message>           送信するメッセージ（残りの引数を連結）
  --workspace <path>  ワークスペース（省略時: GH_MAESTRO_WORKSPACE env > CWD から上方探索）

worker-name は .gh-maestro/workers.json で pane-id に解決される。送信方向に応じて
送信者名がメッセージ先頭に自動付与される。<message> は .gh-maestro/messages/ にファイル
として書かれ、pane にはそのファイルを読むよう促す短文だけが送られる。`;

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
  const workers = JSON.parse(readFileSync(workersJson, 'utf8'));
  const myPaneId = String(process.env.WEZTERM_PANE ?? '');
  if (myPaneId) {
    for (const [k, v] of Object.entries(workers)) {
      if (normalizeWorkerEntry(v).paneId === myPaneId) { senderName = k; break; }
    }
  }
}

// 送信者名をメッセージ先頭に付与
const prefix = senderName === 'orchestrator'
  ? 'orchestratorです。'
  : senderName ? `${senderName}担当workerです。` : '';

// ── 送信 ────────────────────────────────────────────────────────────────

// 本文は特殊文字（"@" 等）によるEnter消費を避けるためファイルへ退避し、
// pane には固定テンプレートの短文（ファイルを読むよう促すだけ）を送る。
const messagesDir = path.join(workspace, '.gh-maestro', 'messages');
const messageFile = writeMessageFile(messagesDir, prefix + message);
pruneOldMessageFiles(messagesDir, 24 * 60 * 60 * 1000);
const notification = `${prefix}新着メッセージがあります。${messageFile} を読んでください。`;

// pane 解決・cwd 検証・ロック・Enter 送出は pane-notify.js に委譲
const ok = notifyPane(workspace, name, notification);
process.exit(ok ? 0 : 1);
