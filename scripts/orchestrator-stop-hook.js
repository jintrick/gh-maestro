#!/usr/bin/env node
'use strict';

// orchestrator の対話型セッションで人間へ通知する Claude Code plugin の hook。
// 通知を orchestrator 自身の操作に任せると、SKILL.md に書いてあっても発言の瞬間に
// 想起されず送られない（Issue #611）。Stop、StopFailure、PermissionRequest で予約する。
//
// Stop / StopFailure / PermissionRequest で30秒後の通知を予約し、次の人間の入力
// （UserPromptSubmit）で取り消す。plugin monitor の task-notification は人間の入力では
// ないため予約を維持する。PostToolUse / PostToolUseFailure は PermissionRequest 由来の
// 予約だけ取り消す。拒否・中断のあと何も入力されなければ通知する。
// 次の Stop が予約し直す場合も含め、予約は1つにまとまる
// （docs/adr/0045-notify-human-on-every-orchestrator-stop.md）。予約hookは async で
// 登録されているため、hook の中で待っても応答や許可画面を止めない。
//
// plugin hook はヘッドレスのワーカーや gh-maestro を使わないセッションでも発火するため、
// /gh-maestro のセッション初期化（gh-maestro-session-hook.js）が記録したセッションIDと
// 一致するときだけ予約・取り消しを行う。
// 失敗してもClaude Codeの応答・対話を止めないよう、終了コード2（ブロック）は使わない。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('./shared/child-process');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { ensureWorkspaceRuntimeDir, workspaceRuntimeDir } = require('./shared/storage-layout');
const { atomicWriteJson } = require('./shared/atomic-write');
const { readJsonFile, parseJsonText } = require('./shared/json-file');
const { renderNotificationGuidance } = require('./shared/orchestrator-guidance');

const USAGE = `orchestrator-stop-hook.js — orchestratorセッション専用のClaude Code notification hooks

Usage:
  node orchestrator-stop-hook.js            Stop / StopFailure / PermissionRequest hook として通知を予約する
  node orchestrator-stop-hook.js --cancel   PostToolUse / PostToolUseFailure / UserPromptSubmit hook として予約を取り消す
  node orchestrator-stop-hook.js --help | -h

hook の入力JSON（session_id, cwd）を標準入力から読む（TTYならエラー）。
workspace は CLAUDE_PROJECT_DIR、なければhook入力の cwd から解決する。
session_id が /gh-maestro のセッション初期化で記録されたIDと一致するときだけ動く。
一致しないとき・記録が無いときは何もせず終了コード0。

予約（引数なし）: Stop、StopFailure、PermissionRequest で30秒後の通知を予約して待つ。
  待つあいだに次の予約か --cancel があれば、通知せず終了する。何も起きなければ
  notify-human.js を1回実行する。
取り消し（--cancel）: 人間の UserPromptSubmit はすべての予約を、PostToolUse /
  PostToolUseFailure は PermissionRequest 由来の予約だけを取り消す。plugin monitor の
  task-notification による UserPromptSubmit は予約を維持し、宣言済み手順書があれば
  hookSpecificOutput.additionalContext として返す。人間の入力には文脈を追加しない。
  拒否・中断だけで人間の入力が続かない場合は予約を維持し、通知する。

失敗時は終了コード1（Claude Codeの処理は止めない）。`;

const SPEC = {
  flags: {},
  booleans: ['--help', '-h', '--cancel'],
  positionals: { min: 0, max: 0 },
};

const MARKER_FILE = 'orchestrator-claude-session.json';
const PENDING_FILE = 'orchestrator-pending-notification.json';
const NOTIFY_DELAY_MS = 30000;

function pendingPath(workspace, runtimeRootOverride) {
  return path.join(workspaceRuntimeDir(workspace, runtimeRootOverride), PENDING_FILE);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 予約中の通知のトークンを読む。予約が無いことは正常な不在として null を返し、
 * 壊れた予約は修復せず例外にする。
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readPendingToken(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = readJsonFile(filePath);
  if (!data || typeof data !== 'object' || typeof data.token !== 'string' || data.token === '') {
    throw new Error(`通知の予約が不正です: ${filePath}`);
  }
  return data.token;
}

function markerPath(workspace, runtimeRootOverride) {
  return path.join(workspaceRuntimeDir(workspace, runtimeRootOverride), MARKER_FILE);
}

/**
 * /gh-maestro を実行したClaudeセッションを orchestrator として記録する。
 * 後の /gh-maestro で上書きされ、前のセッションは通知の対象外になる。
 *
 * @param {string} workspace resolveWorkspace() 済みのworkspace
 * @param {string} sessionId Claude Code の session_id
 * @param {object} [options]
 * @param {string} [options.runtimeRoot] テスト用のruntime root
 * @param {Function} [options.now]
 * @returns {string} 書き込んだファイル
 */
function markOrchestratorSession(workspace, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('記録するセッションIDがありません');
  }
  const file = markerPath(workspace, options.runtimeRoot);
  if (options.runtimeRoot === undefined) ensureWorkspaceRuntimeDir(workspace, { register: false });
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, {
    schemaVersion: 1,
    sessionId,
    recordedAt: (options.now || (() => new Date()))().toISOString(),
  });
  return file;
}

/**
 * 記録済みのorchestratorセッションIDを読む。
 * 記録が無いことは正常な不在として null を返し、壊れた記録は修復せず例外にする。
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readMarkedSessionId(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = readJsonFile(filePath);
  if (!data || typeof data !== 'object' || typeof data.sessionId !== 'string' || data.sessionId === '') {
    throw new Error(`orchestratorセッション記録が不正です: ${filePath}`);
  }
  return data.sessionId;
}

function parseHookInput(text) {
  const input = parseJsonText(text);
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || input.session_id === '') {
    throw new Error('hook入力に session_id がありません');
  }
  return input;
}

/**
 * hook入力が記録済みの orchestrator セッションのものなら、その workspace を返す。
 *
 * @param {object} input hook入力（session_id, cwd）
 * @param {object} deps
 * @returns {string|null}
 */
function resolveOrchestratorWorkspace(input, deps) {
  const env = deps.env || process.env;
  const resolveWorkspaceFn = deps.resolveWorkspaceFn || resolveWorkspace;
  // gh-maestro を使っていないプロジェクトでも plugin hook は発火する。
  const workspace = resolveWorkspaceFn(env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!workspace) return null;
  if (readMarkedSessionId(markerPath(workspace, deps.runtimeRoot)) !== input.session_id) return null;
  return workspace;
}

/**
 * Stop / StopFailure / PermissionRequest hook の1回分の処理。
 * 通知を予約して待ち、予約が残っていれば通知する。
 * 副作用はdepsで差し替えられる。
 *
 * @param {object} input hook入力（session_id, cwd）
 * @param {object} [deps]
 * @returns {{exitCode:number, stderr?:string}}
 */
function runNotificationHook(input, deps = {}) {
  const workspace = resolveOrchestratorWorkspace(input, deps);
  if (!workspace) return { exitCode: 0 };
  if (input.hook_event_name === 'Stop' && typeof input.last_assistant_message === 'string'
    && input.last_assistant_message.trimEnd().endsWith('—')) return { exitCode: 0 };

  const file = pendingPath(workspace, deps.runtimeRoot);
  const token = (deps.randomUUIDFn || crypto.randomUUID)();
  atomicWriteJson(file, {
    schemaVersion: 1,
    token,
    hookEventName: input.hook_event_name || 'Stop',
    scheduledAt: (deps.now || (() => new Date()))().toISOString(),
  });
  (deps.sleepFn || sleepSync)(deps.delayMs === undefined ? NOTIFY_DELAY_MS : deps.delayMs);
  // 待つあいだに次の Stop が予約し直したか、人間の入力で取り消された。
  if (readPendingToken(file) !== token) return { exitCode: 0 };
  fs.rmSync(file, { force: true });

  const spawnSyncFn = deps.spawnSyncFn || spawnSync;
  const result = spawnSyncFn(process.execPath, [
    path.join(deps.scriptsDir || __dirname, 'notify-human.js'), '--workspace', workspace,
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message || String(result?.stderr || '').trim() || `exit ${result?.status}`;
    return { exitCode: 1, stderr: `orchestrator-stop-hook: 通知に失敗しました: ${detail}\n` };
  }
  return { exitCode: 0 };
}

/**
 * PostToolUse / UserPromptSubmit hook の1回分の処理。予約中の通知を取り消す。
 *
 * @param {object} input hook入力（session_id, cwd）
 * @param {object} [deps]
 * @returns {{exitCode:number, stdout?:string}}
 */
function runCancelHook(input, deps = {}) {
  const workspace = resolveOrchestratorWorkspace(input, deps);
  if (!workspace) return { exitCode: 0 };
  if (input.hook_event_name === 'UserPromptSubmit'
    && typeof input.prompt === 'string'
    && input.prompt.startsWith('<task-notification>')) {
    const additionalContext = (deps.renderNotificationGuidanceFn || renderNotificationGuidance)({
      workspace,
      prompt: input.prompt,
      skillDirectory: deps.skillDirectory,
      resolveSkillMdPathFn: deps.resolveSkillMdPathFn,
    });
    if (!additionalContext) return { exitCode: 0 };
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext,
        },
      }),
    };
  }
  const file = pendingPath(workspace, deps.runtimeRoot);
  if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') {
    const pending = readPending(file);
    if (!pending || pending.hookEventName !== 'PermissionRequest') return { exitCode: 0 };
  }
  fs.rmSync(file, { force: true });
  return { exitCode: 0 };
}

function readPending(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const data = readJsonFile(filePath);
  if (!data || typeof data !== 'object' || typeof data.token !== 'string' || data.token === '') {
    throw new Error(`通知の予約が不正です: ${filePath}`);
  }
  return data;
}

function main(argv = process.argv.slice(2), options = {}) {
  const writeStdout = options.writeStdoutFn || ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderrFn || ((value) => process.stderr.write(value));
  const isStdinTTY = options.isStdinTTY || (() => process.stdin.isTTY);
  const readStdin = options.readStdinFn || (() => fs.readFileSync(0, 'utf8'));

  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error && error.helpRequested) {
      writeStdout(`${USAGE}\n`);
      return 0;
    }
    if (error && error.name === 'ArgsValidationError') {
      for (const item of error.errors) writeStderr(`orchestrator-stop-hook: ${item.message}\n`);
      writeStderr(`${USAGE}\n`);
      return 1;
    }
    throw error;
  }
  if (values['--help'] || values['-h']) {
    writeStdout(`${USAGE}\n`);
    return 0;
  }
  if (isStdinTTY()) {
    writeStderr('orchestrator-stop-hook: 標準入力がTTYです。hook入力のJSONをパイプで渡してください\n');
    return 1;
  }

  try {
    const input = parseHookInput(readStdin());
    const result = values['--cancel'] ? runCancelHook(input, options) : runNotificationHook(input, options);
    if (result.stdout) writeStdout(`${result.stdout}\n`);
    if (result.stderr) writeStderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    writeStderr(`orchestrator-stop-hook: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  USAGE, SPEC, MARKER_FILE, PENDING_FILE, NOTIFY_DELAY_MS, markerPath, pendingPath, readPendingToken,
  runCancelHook, markOrchestratorSession, readMarkedSessionId,
  parseHookInput, runNotificationHook, main,
};

if (require.main === module) {
  process.exitCode = main();
}
