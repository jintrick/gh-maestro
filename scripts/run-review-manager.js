#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('./child-process');
const { buildAgentCommandArgs } = require('./agent-launch');
const { resolveAgentConfig, resolveSkillAgentMap } = require('./shared/resolve-config');
const { assertValidPr, reviewArtifactPath } = require('./shared/review-manager-paths');

const USAGE = `run-review-manager.js — Review Managerをheadless起動してPRレビューを実行する

Usage: node run-review-manager.js <PR> <REPO> <WORKSPACE> [--mode heavy|directed] [--brief-file <path>]

Arguments:
  <PR>         レビュー対象の PR 番号
  <REPO>       GitHub リポジトリ(owner/repo)
  <WORKSPACE>  ワークスペースの絶対パス

Options:
  --mode <heavy|directed>  レビュー戦略（デフォルト: heavy）
  --brief-file <path>      directedモードのレビュー方針ファイル（directed時必須）

このスクリプトは通常 start-review-manager.js から detach 起動される内部エンドポイント。
directed モードでの --brief-file は完了後に削除される（start-review-manager.js が
このプロセス専用に確保した一時コピーである前提）。

観測用に review-manager-<PR>.meta.json へ mode を記録する。directed モードの
レビュー方針そのものはログ・メタデータに残さず、SHA-256ハッシュとバイト長のみを記録する。`;

const VALID_MODES = new Set(['heavy', 'directed']);

/**
 * @param {string|null} mode
 * @returns {string} 検証済みmode（'heavy'|'directed'）
 */
function resolveMode(mode) {
  const resolved = mode || 'heavy';
  if (!VALID_MODES.has(resolved)) {
    throw new Error(`invalid mode "${resolved}" (must be "heavy" or "directed")`);
  }
  return resolved;
}

/**
 * @param {{pr: string, repo: string, workspace: string, outputFile: string, mode: string, directedBrief?: string|null}} params
 * @returns {string}
 */
function buildPrompt({ pr, repo, workspace, outputFile, mode, directedBrief }) {
  const toUnix = p => p.replace(/\\/g, '/');
  const header = `gh-maestro-reviewerスキルを発動し、Review ManagerとしてPRレビューを実行してください。

PR=${pr}
REPO=${repo}
WORKSPACE=${toUnix(workspace)}
OUTPUT=${toUnix(outputFile)}
MODE=${mode}
`;

  if (mode === 'directed') {
    return `${header}
オーケストレーターから以下のレビュー方針が与えられています。この方針の範囲に絞ってレビューしてください。

---
${directedBrief}
---

必ず以下を守ってください。
- GitHubへ投稿しない
- 採否判断しない
- 上記レビュー方針の範囲に絞ってレビューする（方針外の観点は無理に指摘しない）
- 各findingのaspectには Correctness / Maintainability / Resilience & Security のうち最も近いものを付与する
- 最終結果はOUTPUTのJSONだけに書き出す（heavyモードと同一のJSON形式）
`;
  }

  return `${header}
必ず以下を守ってください。
- GitHubへ投稿しない
- 採否判断しない
- 3観点のReviewerを独立に並列spawnする
- Reviewerには該当する観点別基準ファイルを読ませる
- 最終結果はOUTPUTのJSONだけに書き出す
`;
}

/**
 * テキストの機微性を保ったまま観測可能にするため、本文の代わりにSHA-256とバイト長を返す。
 * @param {string} text
 * @returns {{sha256: string, length: number}}
 */
function digestText(text) {
  return {
    sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    length: Buffer.byteLength(text, 'utf8'),
  };
}

/**
 * どのmode（と、directedならレビュー方針のダイジェスト）で起動されたかを、
 * findings JSON本体とは別のメタデータファイルに書き出す。
 * findings JSONのスキーマ（review-findings-schema.json, additionalProperties:false）を
 * 変更せずに観測可能性を確保するため、payloadには一切書き込まない（PR #84 Review指摘）。
 * directed のレビュー方針本文はログ・メタデータのどちらにも残さない
 * （機微情報が含まれる可能性があるため。PR #84 Review指摘）。
 *
 * @param {string} metaFile
 * @param {string} mode
 * @param {string|null} [directedBrief]
 */
function writeRunMetadata(metaFile, mode, directedBrief) {
  const metadata = { mode };
  if (mode === 'directed' && directedBrief != null) {
    metadata.directedBrief = digestText(directedBrief);
  }
  fs.writeFileSync(metaFile, JSON.stringify(metadata, null, 2), 'utf8');
}

// argv を1回だけ順に走査し、各フラグが消費した値をフラグ判定・位置引数の対象から除外する。
// これをしないと --brief-file '--help' のような値そのものが誤ってフラグとして解釈される。
function parseArgs(argv) {
  let help = false;
  let mode, briefFile;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--mode') {
      mode = argv[++i];
    } else if (a === '--brief-file') {
      briefFile = argv[++i];
    } else {
      positional.push(a);
    }
  }
  return { help, mode, briefFile, positional };
}

module.exports = { resolveMode, buildPrompt, digestText, writeRunMetadata, parseArgs };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { help, mode: modeArg, briefFile: briefFileArg, positional } = parseArgs(argv);

  if (help) {
    console.log(USAGE);
    process.exit(0);
  }

  const [pr, repo, workspace] = positional;

  if (!pr || !repo || !workspace) {
    console.error(USAGE);
    process.exit(1);
  }

  // pr はファイルパス構成要素として使われるため、他の処理より先に検証する
  // （PR #84 Review指摘: pathトラバーサル対策）。
  try {
    assertValidPr(pr);
  } catch (e) {
    console.error(`run-review-manager: ${e.message}`);
    process.exit(1);
  }

  let mode;
  try {
    mode = resolveMode(modeArg);
  } catch (e) {
    console.error(`run-review-manager: ${e.message}`);
    process.exit(1);
  }

  let directedBrief = null;
  if (mode === 'directed') {
    if (!briefFileArg) {
      console.error('run-review-manager: directed モードには --brief-file が必要です');
      process.exit(1);
    }
    try {
      directedBrief = fs.readFileSync(briefFileArg, 'utf8');
    } catch (e) {
      console.error(`run-review-manager: brief file を読めません: ${e.message}`);
      process.exit(1);
    }
  }

  const ghDir = path.join(workspace, '.gh-maestro');
  const lockFile = reviewArtifactPath(ghDir, pr, '.running');
  const logFile = reviewArtifactPath(ghDir, pr, '.log');
  const outputFile = reviewArtifactPath(ghDir, pr, '.json');
  const metaFile = reviewArtifactPath(ghDir, pr, '.meta.json');
  const promptFile = path.join(os.tmpdir(), `review-manager-prompt-${pr}-${Date.now()}.md`);

  function log(msg) {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  }

  function cleanup() {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
    if (briefFileArg) { try { fs.unlinkSync(briefFileArg); } catch {} }
  }

  // process.exit() は try/finally をスキップする（finally 内の cleanup() が実行されない）ため、
  // 終了コードは変数に保持し、finally 完了後に一度だけ process.exit() する。
  // mkdirSync/lockFile書き込み/log()もtry内に含める。ここで例外（ディスク容量不足・
  // 権限エラー等）が発生した場合でもfinallyのcleanup()を確実に実行するため。
  let exitCode = 0;
  try {
    fs.mkdirSync(ghDir, { recursive: true });

    // lock ファイルに自PIDを記録（起動元 launcher のPIDを上書き）。
    // launcher (start-review-manager.js) は detach 後すぐに終了するため、
    // 子プロセスである run-review-manager.js 自身が lock を所有・更新する。
    // これにより isLockValid が正しく稼働中プロセスのPIDを確認できる。
    fs.writeFileSync(lockFile, String(process.pid));

    log(`run-review-manager started pr=${pr} repo=${repo} mode=${mode}`);
    if (mode === 'directed') {
      const digest = digestText(directedBrief);
      log(`directed brief sha256=${digest.sha256} length=${digest.length}`);
    }
    writeRunMetadata(metaFile, mode, directedBrief);

    fs.writeFileSync(promptFile, buildPrompt({ pr, repo, workspace, outputFile, mode, directedBrief }), 'utf8');
    spawnSync('git', ['-C', workspace, 'fetch', 'origin', `pull/${pr}/head`], { stdio: 'ignore' });

    const skill = 'gh-maestro-reviewer';
    const skillMap = resolveSkillAgentMap({ workspace });
    const agentId = skillMap[skill] ?? 'codex';
    const homedir = process.env.HOME || process.env.USERPROFILE || '';
    let agentConfig = resolveAgentConfig(agentId, { workspace, homedir });

    if (agentId === 'codex') {
      const cmd = agentConfig?.command ?? 'codex';
      agentConfig = {
        command: cmd,
        extraArgs: [
          'exec',
          '--cd', workspace,
          '--model', 'gpt-5.4',
          '--sandbox', 'danger-full-access',
        ],
        promptDelivery: agentConfig?.promptDelivery ?? 'positional',
      };
    } else if (!agentConfig) {
      agentConfig = {
        command: 'codex',
        extraArgs: [
          'exec',
          '--cd', workspace,
          '--model', 'gpt-5.4',
          '--sandbox', 'danger-full-access',
        ],
        promptDelivery: 'positional',
      };
    }

    const agentArgs = buildAgentCommandArgs(agentConfig, {
      promptFile,
      shortPrompt: `Read ${promptFile.replace(/\\/g, '/')} and execute it.`,
      systemPromptText: `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。`,
    });

    log(`spawning ${agentArgs.join(' ')}`);
    const result = spawnSync(agentArgs[0], agentArgs.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });

    if (result.error) log(`spawn error: ${result.error.message}`);
    if (result.stdout) log(result.stdout);
    if (result.stderr) log(result.stderr);
    log(`${agentArgs[0]} exited with status ${result.status}`);

    if (result.status !== 0) {
      exitCode = result.status ?? 1;
    } else if (!fs.existsSync(outputFile)) {
      log(`RM output not found: ${outputFile}`);
      exitCode = 1;
    } else {
      const publish = spawnSync(process.execPath, [
        path.join(__dirname, 'review-publisher.js'),
        outputFile,
      ], {
        cwd: workspace,
        encoding: 'utf8',
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
      });
      if (publish.stdout) log(publish.stdout);
      if (publish.stderr) log(publish.stderr);
      log(`review-publisher exited with status ${publish.status}`);
      exitCode = publish.status ?? 0;
    }
  } finally {
    cleanup();
  }
  process.exit(exitCode);
}
