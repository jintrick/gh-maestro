#!/usr/bin/env node
'use strict';

const { spawn } = require('./child-process');
const fs = require('fs');
const path = require('path');
const { isProcessAlive } = require('./process-lifecycle');
const { assertValidPr, reviewArtifactPath } = require('./shared/review-manager-paths');
const { resolveTextInput } = require('./shared/text-input');
const { toWinPath } = require('./win-path');

const USAGE = `start-review-manager.js — PRに対してReview Managerを起動する

Usage: node start-review-manager.js <PR> <REPO> <WORKSPACE> [--mode heavy|directed] [--prompt <text> | --brief-file <path>]

Options:
  --mode <heavy|directed>  レビュー戦略（デフォルト: heavy）
                            heavy: 既存の3観点独立サブエージェント方式
                            directed: 指定したレビュー方針に沿って絞ったレビューを行う
  --prompt <text>           directedモードのレビュー方針をテキストで直接指定する
  --brief-file <path>       directedモードのレビュー方針をファイルで指定する
                            （--prompt と --brief-file はどちらか一方のみ指定可能）

directed モードでは --prompt または --brief-file のいずれかが必須。

Output:
  REVIEW_MANAGER_STARTED:<PR>
  REVIEW_MANAGER_ALREADY_RUNNING:<PR>`;

const VALID_MODES = new Set(['heavy', 'directed']);

/**
 * @param {{mode?: string}} options
 * @returns {string} 検証済みmode（'heavy'|'directed'）
 */
function resolveMode(options) {
  const mode = options.mode || 'heavy';
  if (!VALID_MODES.has(mode)) {
    throw new Error(`invalid mode "${mode}" (must be "heavy" or "directed")`);
  }
  return mode;
}

/**
 * directedモードのレビュー方針テキストを解決する。
 * @param {{promptText?: string, briefFile?: string}} options
 * @returns {string}
 */
function resolveDirectedBrief(options) {
  if (options.promptText != null && options.briefFile != null) {
    throw new Error('--prompt と --brief-file は同時に指定できません');
  }
  const briefFile = options.briefFile != null ? toWinPath(options.briefFile) : null;
  if (briefFile != null && !fs.existsSync(briefFile)) {
    throw new Error(`brief file not found: ${options.briefFile}`);
  }
  const text = resolveTextInput({ inlineValue: options.promptText ?? null, filePath: briefFile });
  if (text != null) return text;
  throw new Error('directed モードには --prompt または --brief-file が必要です');
}

/**
 * lock ファイルが有効かチェックする。
 * lock ファイルに記録されたPIDが生存していれば true（既に起動済み）。
 * PIDが死んでいる（stale）場合は lock ファイルを削除して false を返す。
 *
 * req.13: lock に PID を記録し、生存＋同一性確認で stale 判定
 *
 * @param {string} lockFile
 * @returns {boolean} true = 有効なlock（既に起動済み）, false = stale または lock なし
 */
function isLockValid(lockFile) {
  if (!fs.existsSync(lockFile)) return false;

  let lockPid;
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    lockPid = parseInt(raw, 10);
  } catch {
    // lock ファイル破損 → stale 扱い
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  }

  if (!Number.isFinite(lockPid) || lockPid <= 0) {
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  }

  if (isProcessAlive(lockPid)) return true;

  // プロセスは死んでいる → stale lock
  try { fs.unlinkSync(lockFile); } catch {}
  return false;
}

/**
 * @param {string} pr
 * @param {string} repo
 * @param {string} workspace
 * @param {{mode?: string, promptText?: string, briefFile?: string}} [options]
 */
function startReviewManager(pr, repo, workspace, options = {}) {
  // 副作用（lock/brief書き込み）の前に入力を検証する（fail-closed）。
  // pr はファイルパス構成要素として使われるため、厳密な正整数であることを
  // ここで確定させる（PR #84 Review指摘: pathトラバーサル対策）。
  assertValidPr(pr);
  const mode = resolveMode(options);

  const ghDir = path.join(workspace, '.gh-maestro');
  fs.mkdirSync(ghDir, { recursive: true });
  const lockFile = reviewArtifactPath(ghDir, pr, '.running');

  // req.13: stale 判定付きで lock チェック
  if (isLockValid(lockFile)) return 'REVIEW_MANAGER_ALREADY_RUNNING';

  // directed モードのレビュー方針を、子プロセス（run-review-manager.js）が
  // 読める独自の一時ファイルとしてghDir配下に確保する。
  // オーケストレーターが渡した --brief-file の原本を書き換えないよう、常にコピーする。
  let briefFile = null;
  if (mode === 'directed') {
    const briefText = resolveDirectedBrief(options);
    briefFile = reviewArtifactPath(ghDir, pr, '-brief.md');
    fs.writeFileSync(briefFile, briefText, 'utf8');
  }

  fs.writeFileSync(lockFile, String(process.pid));
  const logFd = fs.openSync(reviewArtifactPath(ghDir, pr, '.log'), 'a');
  const childArgs = [
    path.join(__dirname, 'run-review-manager.js'),
    pr,
    repo,
    workspace,
    '--mode', mode,
  ];
  if (briefFile) childArgs.push('--brief-file', briefFile);
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  // spawn失敗・子プロセス終了のどちらでも lock/brief 双方を解放する
  // （briefFileだけ残留すると次回起動までゴミとして残る。PR #84 Review指摘）。
  const releaseArtifacts = () => {
    try { fs.unlinkSync(lockFile); } catch {}
    if (briefFile) { try { fs.unlinkSync(briefFile); } catch {} }
  };
  child.on('error', releaseArtifacts);
  child.on('exit', releaseArtifacts);
  child.unref();
  fs.closeSync(logFd);
  return 'REVIEW_MANAGER_STARTED';
}

/**
 * @param {string[]} aspects
 * @returns {string}
 */
function buildAspectsBrief(aspects) {
  if (!Array.isArray(aspects) || aspects.length === 0) {
    throw new Error('buildAspectsBrief には1件以上の観点が必要です');
  }
  const aspectsLine = `ASPECTS=${aspects.join(',')}`;
  return `オーケストレーターが変更内容から選定した観点に絞ってレビューしてください。` +
    `skills/gh-maestro-reviewer/ 配下の以下の観点ファイルに対応する基準のみを適用します。\n\n` +
    aspects.map(a => `- ${a}`).join('\n') + `\n\n${aspectsLine}\n`;
}

module.exports = { startReviewManager, isLockValid, resolveMode, resolveDirectedBrief, buildAspectsBrief };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const getFlag = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] ?? null : null; };
  const flagSet = new Set(['--mode', '--prompt', '--brief-file']);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (flagSet.has(args[i])) { i++; continue; }
    positional.push(args[i]);
  }
  const [pr, repo, workspace] = positional;
  if (!pr || !repo || !workspace) {
    console.error(USAGE);
    process.exit(1);
  }

  const options = {
    mode: getFlag('--mode') || undefined,
    promptText: getFlag('--prompt') || undefined,
    briefFile: getFlag('--brief-file') || undefined,
  };

  try {
    process.stdout.write(`${startReviewManager(pr, repo, workspace, options)}:${pr}\n`);
  } catch (e) {
    console.error(`start-review-manager: ${e.message}`);
    process.exit(1);
  }
}
