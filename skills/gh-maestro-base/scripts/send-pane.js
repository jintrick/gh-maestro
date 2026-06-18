#!/usr/bin/env node
// Usage: node send-pane.js <worker-name> <message> --workspace <path>
//
// worker-name は .gh-maestro/workers.json で pane-id に解決される。
// "orchestrator" を指定するとorchestratorペインに送信する。
// 送信方向に応じて送信者名を自動的にメッセージ先頭に付与する。

const path = require('path');
const { spawnSync } = require('child_process');
const { readFileSync, existsSync } = require('fs');

const args = process.argv.slice(2);
const wsIdx = args.indexOf('--workspace');
const workspaceArg = wsIdx !== -1 ? args[wsIdx + 1] : null;
// env var を優先し、なければ --workspace 引数、なければ後方互換パス
const workspace = process.env.GH_MAESTRO_WORKSPACE ?? workspaceArg ?? null;

// --workspace とその値を除いた残りを解析
const rest = args.filter((_, i) => i !== wsIdx && i !== wsIdx + 1);
const [name, ...msgParts] = rest;
const message = msgParts.join(' ');

if (!name || !message) {
  console.error('Usage: send-pane.js <worker-name> <message>');
  process.exit(1);
}

// workers.json のパスを解決
const workersJson = workspace
  ? path.resolve(workspace, '.gh-maestro', 'workers.json')
  : path.resolve(__dirname, '..', 'workers.json'); // 後方互換

let paneId = name;
let senderName = null;

if (existsSync(workersJson)) {
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

// 送信者名をメッセージ先頭に付与
const prefix = senderName === 'orchestrator'
  ? 'orchestratorです。'
  : senderName ? `${senderName}担当workerです。` : '';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 800;
const WEZ_TIMEOUT_MS = 6000;

function wez(...a) {
  return spawnSync('wezterm', a, { encoding: 'utf8', timeout: WEZ_TIMEOUT_MS });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function wezOk(result, label) {
  if (result.error?.code === 'ETIMEDOUT') {
    process.stderr.write(`send-pane: wezterm ${label} timed out after ${WEZ_TIMEOUT_MS}ms\n`);
    return false;
  }
  if (result.status !== 0) {
    process.stderr.write(`send-pane: wezterm ${label} failed (exit ${result.status}): ${result.stderr?.trim()}\n`);
    return false;
  }
  return true;
}

// --no-paste で送信してテキストを入力行に残し、get-text で確認後にEnterを送る。
// ただし send-text が exit 0 でも稀に届かないケースがあるため確認を行う。
// 確認できなかった場合も必ずEnterを送る（宙ぶらりん防止）。
// リトライは send-text 自体が失敗した場合のみ行う（確認失敗でリトライすると重複する）。
// --no-paste で送信する理由:
//   paste モードでは agy が bracketed paste を受け取り即実行してしまい、
//   確認IDが消えて偽失敗→リトライ→重複送信が起きる。
//   --no-paste ならテキストが入力行に残り、確認→Enter送信の流れが正しく機能する。
//   リトライ時は Ctrl+U で前回分を消してから再送するため重複しない。
//
// 最終試行で確認できなかった場合も Enter を送る（宙ぶらりん防止）。

const POLL_INTERVAL_MS = 200;
const POLL_MAX = 15;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  const id = Math.random().toString(36).slice(2, 8);
  const fullMessage = prefix + message + ` [${id}]`;

  if (attempt > 1) {
    wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\x15'); // 前回分をクリア
    sleep(200);
  }

  const sendResult = wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', fullMessage);
  if (!wezOk(sendResult, `cli send-text (attempt ${attempt})`)) {
    if (attempt < MAX_RETRIES) sleep(RETRY_DELAY_MS);
    continue;
  }

  // 確認IDが入力行に表示されるまでポーリング（200ms×15回 = 最大3秒）
  let confirmed = false;
  for (let p = 0; p < POLL_MAX; p++) {
    sleep(POLL_INTERVAL_MS);
    const r = wez('cli', 'get-text', '--pane-id', paneId);
    if (r.stdout && r.stdout.includes(id)) { confirmed = true; break; }
  }

  if (confirmed) {
    wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
    process.exit(0);
  }

  // 確認できなかった: 最終試行なら宙ぶらりん防止のためEnterを送って終了、それ以外はリトライ
  if (attempt === MAX_RETRIES) {
    process.stderr.write(`send-pane: confirmation not found — sending Enter anyway on final attempt\n`);
    wez('cli', 'send-text', '--pane-id', paneId, '--no-paste', '\r');
    process.exit(0);
  }
  process.stderr.write(`send-pane: confirmation not found (attempt ${attempt}) — retrying\n`);
  sleep(RETRY_DELAY_MS);
}

process.stderr.write(`send-pane: failed to deliver message after ${MAX_RETRIES} attempts\n`);
process.exit(1);
