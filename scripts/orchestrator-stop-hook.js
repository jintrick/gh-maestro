#!/usr/bin/env node
'use strict';

// orchestrator の対話型セッションで、人間に問いを投げて応答を終えたときだけ通知する
// Claude Code plugin の Stop hook。
// 通知を orchestrator 自身の操作に任せると、SKILL.md に書いてあっても発言の瞬間に
// 想起されず送られない（Issue #611）。応答の終わりに必ず発火する Stop hook で送る。
//
// plugin hook はヘッドレスのワーカーや gh-maestro を使わないセッションでも発火するため、
// /gh-maestro のセッション初期化（gh-maestro-session-hook.js）が記録したセッションIDと
// 一致するときだけ通知する。判断・承認を求める発言は末尾に問いを1つ置く規範なので、
// 応答の最後が問いで終わるときだけ通知し、人間に用の無いターンでは鳴らさない。
// 失敗してもClaude Codeの応答・対話を止めないよう、終了コード2（ブロック）は使わない。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./shared/child-process');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { ensureWorkspaceRuntimeDir, workspaceRuntimeDir } = require('./shared/storage-layout');
const { atomicWriteJson } = require('./shared/atomic-write');
const { readJsonFile, parseJsonText } = require('./shared/json-file');

const USAGE = `orchestrator-stop-hook.js — orchestratorセッション専用のClaude Code Stop hook

Usage:
  node orchestrator-stop-hook.js
  node orchestrator-stop-hook.js --help | -h

Stop hook の入力JSON（session_id, last_assistant_message）を標準入力から読む（TTYならエラー）。
workspace は CLAUDE_PROJECT_DIR、なければhook入力の cwd から解決する。
次の両方を満たすときだけ notify-human.js を実行する:
  - session_id が /gh-maestro のセッション初期化で記録されたIDと一致する
  - last_assistant_message の末尾が問い（？ または ?）で終わる
満たさないときは何もせず終了コード0。失敗時は終了コード1（Claude Codeの処理は止めない）。`;

const SPEC = {
  flags: {},
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

const MARKER_FILE = 'orchestrator-claude-session.json';

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

/**
 * 応答の末尾が問いかを判定する。末尾の空白と、問いを囲むMarkdownの強調・コード・
 * 括弧・引用符は取り除いてから見る（例: `**〜ですか？**`）。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
function endsWithQuestion(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.replace(/[\s*_`」』）)"'”’]+$/u, '');
  return /[？?]$/u.test(trimmed);
}

function parseHookInput(text) {
  const input = parseJsonText(text);
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || input.session_id === '') {
    throw new Error('hook入力に session_id がありません');
  }
  return input;
}

/**
 * Stop hook の1回分の処理。副作用はdepsで差し替えられる。
 *
 * @param {object} input hook入力（session_id, last_assistant_message, cwd）
 * @param {object} [deps]
 * @returns {{exitCode:number, stderr?:string}}
 */
function runStopHook(input, deps = {}) {
  const env = deps.env || process.env;
  const resolveWorkspaceFn = deps.resolveWorkspaceFn || resolveWorkspace;
  // gh-maestro を使っていないプロジェクトでも plugin hook は発火する。
  const workspace = resolveWorkspaceFn(env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!workspace) return { exitCode: 0 };
  if (readMarkedSessionId(markerPath(workspace, deps.runtimeRoot)) !== input.session_id) return { exitCode: 0 };
  if (!endsWithQuestion(input.last_assistant_message)) return { exitCode: 0 };

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
    const result = runStopHook(parseHookInput(readStdin()), options);
    if (result.stderr) writeStderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    writeStderr(`orchestrator-stop-hook: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  USAGE, SPEC, MARKER_FILE, markerPath, markOrchestratorSession, readMarkedSessionId,
  endsWithQuestion, parseHookInput, runStopHook, main,
};

if (require.main === module) {
  process.exitCode = main();
}
