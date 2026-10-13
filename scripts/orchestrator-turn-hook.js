#!/usr/bin/env node
'use strict';

// orchestrator の対話型セッションだけで動く Claude Code plugin hook のエントリポイント。
// 人間へ発言するたびに守るべき規範（送信後の通知・工程番号・問い1つ・詳細はGitHubへ）は、
// SKILL.md に書かれていても発言の瞬間に想起されない（Issue #611）。そこで
//   mark   : /gh-maestro 展開時に、このClaudeセッションをorchestratorとして記録する
//   prompt : 人間の発言が届くたびに、規範の要約を追加文脈として返す
//   stop   : 応答が終わるたびに notify-human.js を実行する
// を行う。plugin hook は gh-maestro を使わないセッションやヘッドレスのワーカーでも
// 発火するため、mark で記録したセッションIDと一致するときだけ prompt/stop を実行する。
// 失敗してもClaude Codeの応答・対話を止めないよう、終了コード2（ブロック）は使わない。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./shared/child-process');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { ensureWorkspaceRuntimeDir, workspaceRuntimeDir } = require('./shared/storage-layout');
const { atomicWriteJson } = require('./shared/atomic-write');
const { readJsonFile, parseJsonText } = require('./shared/json-file');

const USAGE = `orchestrator-turn-hook.js — orchestratorセッション専用のClaude Code plugin hook

Usage:
  node orchestrator-turn-hook.js <mark|prompt|stop>
  node orchestrator-turn-hook.js --help | -h

Modes:
  mark    /gh-maestro の UserPromptExpansion から呼ぶ。hook入力の session_id を
          orchestratorセッションとして workspace runtime に記録する
  prompt  UserPromptSubmit から呼ぶ。記録済みセッションなら
          scripts/orchestrator-turn-reminder.md の内容を additionalContext として出力する
  stop    Stop から呼ぶ。記録済みセッションなら notify-human.js を実行する

hook入力のJSONを標準入力から読む（TTYならエラー）。workspace は CLAUDE_PROJECT_DIR、
なければhook入力の cwd から解決する。記録と異なるセッションでは何もせず終了コード0。
失敗時は終了コード1（Claude Codeの処理は止めない）。`;

const SPEC = {
  flags: {},
  booleans: ['--help', '-h'],
  positionals: { min: 1, max: 1 },
};

const MODES = new Set(['mark', 'prompt', 'stop']);
const MARKER_FILE = 'orchestrator-claude-session.json';
const REMINDER_FILE = path.join(__dirname, 'orchestrator-turn-reminder.md');

function markerPath(workspace, runtimeRootOverride) {
  return path.join(workspaceRuntimeDir(workspace, runtimeRootOverride), MARKER_FILE);
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
 * hookの1回分の処理。副作用はdepsで差し替えられる。
 *
 * @param {string} mode
 * @param {object} input hook入力（session_id, cwd など）
 * @param {object} [deps]
 * @returns {{exitCode:number, stdout?:string, stderr?:string}}
 */
function runHook(mode, input, deps = {}) {
  const env = deps.env || process.env;
  const resolveWorkspaceFn = deps.resolveWorkspaceFn || resolveWorkspace;
  const workspace = resolveWorkspaceFn(env.CLAUDE_PROJECT_DIR || input.cwd);
  if (!workspace) {
    // gh-maestro を使っていないプロジェクトでも plugin hook は発火する。
    if (mode === 'mark') return { exitCode: 1, stderr: 'orchestrator-turn-hook: workspace を解決できません\n' };
    return { exitCode: 0 };
  }
  const file = markerPath(workspace, deps.runtimeRoot);

  if (mode === 'mark') {
    if (deps.runtimeRoot === undefined) ensureWorkspaceRuntimeDir(workspace, { register: false });
    else fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJson(file, {
      schemaVersion: 1,
      sessionId: input.session_id,
      recordedAt: (deps.now || (() => new Date()))().toISOString(),
    });
    return { exitCode: 0 };
  }

  if (readMarkedSessionId(file) !== input.session_id) return { exitCode: 0 };

  if (mode === 'prompt') {
    const reminder = fs.readFileSync(deps.reminderFile || REMINDER_FILE, 'utf8');
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: reminder },
      }),
    };
  }

  // stop
  const spawnSyncFn = deps.spawnSyncFn || spawnSync;
  const result = spawnSyncFn(process.execPath, [
    path.join(deps.scriptsDir || __dirname, 'notify-human.js'), '--workspace', workspace,
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message || String(result?.stderr || '').trim() || `exit ${result?.status}`;
    return { exitCode: 1, stderr: `orchestrator-turn-hook: 通知に失敗しました: ${detail}\n` };
  }
  return { exitCode: 0 };
}

function main(argv = process.argv.slice(2), options = {}) {
  const writeStdout = options.writeStdoutFn || ((value) => process.stdout.write(value));
  const writeStderr = options.writeStderrFn || ((value) => process.stderr.write(value));
  const isStdinTTY = options.isStdinTTY || (() => process.stdin.isTTY);
  const readStdin = options.readStdinFn || (() => fs.readFileSync(0, 'utf8'));

  let values;
  let rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error && error.helpRequested) {
      writeStdout(`${USAGE}\n`);
      return 0;
    }
    if (error && error.name === 'ArgsValidationError') {
      for (const item of error.errors) writeStderr(`orchestrator-turn-hook: ${item.message}\n`);
      writeStderr(`${USAGE}\n`);
      return 1;
    }
    throw error;
  }
  if (values['--help'] || values['-h']) {
    writeStdout(`${USAGE}\n`);
    return 0;
  }
  const mode = rest[0];
  if (!MODES.has(mode)) {
    writeStderr(`orchestrator-turn-hook: 未知のモードです: ${mode}\n${USAGE}\n`);
    return 1;
  }
  if (isStdinTTY()) {
    writeStderr('orchestrator-turn-hook: 標準入力がTTYです。hook入力のJSONをパイプで渡してください\n');
    return 1;
  }

  try {
    const input = parseHookInput(readStdin());
    const result = runHook(mode, input, options);
    if (result.stdout) writeStdout(result.stdout);
    if (result.stderr) writeStderr(result.stderr);
    return result.exitCode;
  } catch (error) {
    writeStderr(`orchestrator-turn-hook: ${error.message}\n`);
    return 1;
  }
}

module.exports = { USAGE, SPEC, MARKER_FILE, REMINDER_FILE, markerPath, readMarkedSessionId, runHook, main };

if (require.main === module) {
  process.exitCode = main();
}
