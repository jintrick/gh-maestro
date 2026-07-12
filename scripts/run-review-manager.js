#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('./child-process');
const { buildAgentCommandArgs } = require('./agent-launch');
const { worktreeAdd, worktreeRemove, worktreePrune } = require('./git-worktree');
const { resolveAgentConfig, resolveSkillAgentMap, resolveReviewManagerVisible } = require('./shared/resolve-config');
const {
  assertValidPr, reviewArtifactPath,
  reviewWorktreeBranchName, reviewWorktreeFetchRef, reviewWorktreeDir,
} = require('./shared/review-manager-paths');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');
const { resolveTextInput } = require('./shared/text-input');

// 可視ペイン実行時、出力ファイル生成を待つポーリング設定。
const VISIBLE_POLL_INTERVAL_MS = 5000;
const VISIBLE_POLL_TIMEOUT_MS = 30 * 60 * 1000;

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

/**
 * Review Manager専用worktreeを作成し、PRのheadコミットの内容に合わせる。
 * git-worktree.js の worktreeAdd はそのまま再利用し（新規実装しない）、
 * PRのhead取得は専用の非トラッキングref（refs/gh-maestro/...）にforce-fetchしてから
 * worktree側で `git reset --hard` する（origin配下の実ブランチと混同しないため）。
 *
 * @param {string} workspace
 * @param {string} pr
 * @param {(msg: string) => void} log
 * @returns {string} 作成したworktreeの絶対パス
 */
function setupReviewWorktree(workspace, pr, log) {
  const worktreesRoot = path.join(workspace, '.gh-maestro', 'worktrees');
  fs.mkdirSync(worktreesRoot, { recursive: true });

  const dir = reviewWorktreeDir(workspace, pr);
  const branchName = reviewWorktreeBranchName(pr);
  const fetchRef = reviewWorktreeFetchRef(pr);

  // 残骸があれば先に除去してから作り直す（spawn-worker.js と同様のリトライパターン）。
  // git worktree prune はディスク上にディレクトリが存在しない登録済みworktreeのメタデータだけを
  // 掃除するため、rmSync（ディレクトリ削除）→ worktreePrune（メタデータ掃除）の順で行う。
  try { worktreeRemove(dir, workspace); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { worktreePrune(workspace); } catch {}
  try { spawnSync('git', ['branch', '-D', '--', branchName], { cwd: workspace, stdio: 'pipe' }); } catch {}

  worktreeAdd(dir, branchName, null, workspace);

  const fetchR = spawnSync('git', ['-C', workspace, 'fetch', 'origin', '--', `+pull/${pr}/head:${fetchRef}`], { stdio: 'pipe', encoding: 'utf8' });
  if (fetchR.status !== 0) {
    throw new Error(`PR head の fetch に失敗しました: ${(fetchR.stderr || '').toString().trim()}`);
  }

  const resetR = spawnSync('git', ['-C', dir, 'reset', '--hard', fetchRef], { stdio: 'pipe', encoding: 'utf8' });
  if (resetR.status !== 0) {
    throw new Error(`worktreeをPR headにリセットできませんでした: ${(resetR.stderr || '').toString().trim()}`);
  }

  log(`review worktree ready: ${dir} (${fetchRef})`);
  return dir;
}

/**
 * Review Manager専用worktreeとその関連git状態（ブランチ・専用ref）を除去する。
 * 各ステップは独立して失敗を許容する（一部残留してもプロセス全体は継続する）。
 *
 * @param {string} workspace
 * @param {string} pr
 * @param {(msg: string) => void} log
 */
function teardownReviewWorktree(workspace, pr, log) {
  const dir = reviewWorktreeDir(workspace, pr);
  const branchName = reviewWorktreeBranchName(pr);
  const fetchRef = reviewWorktreeFetchRef(pr);

  try {
    worktreeRemove(dir, workspace);
  } catch (e) {
    log(`worktree remove 失敗: ${e.message.split('\n')[0]}`);
    // git worktree prune はディスク上にディレクトリが存在しない登録済みworktreeのメタデータだけを
    // 掃除するため、先にディレクトリを消してからpruneする（順序を逆にするとメタデータが残留する）。
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    try { worktreePrune(workspace); } catch {}
  }
  try {
    const delR = spawnSync('git', ['branch', '-D', '--', branchName], { cwd: workspace, stdio: 'pipe', encoding: 'utf8' });
    if (delR.status !== 0) log(`branch -D 失敗: ${(delR.stderr || '').toString().trim()}`);
  } catch (e) { log(`branch -D 例外: ${e.message}`); }
  try {
    spawnSync('git', ['update-ref', '-d', fetchRef], { cwd: workspace, stdio: 'pipe' });
  } catch {}
}

/**
 * headless（既定）でエージェントを起動し、完了まで同期ブロックする。
 * @param {string[]} agentArgs
 * @param {string} cwd
 * @returns {{status: number|null, error?: Error, stdout?: string, stderr?: string}}
 */
function runAgentHeadless(agentArgs, cwd) {
  return spawnSync(agentArgs[0], agentArgs.slice(1), {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * 可視ペイン（wezterm split-pane）に渡すargvを構築する。agent-exec.jsのbuildLoginShellExecArgsと
 * 同様にログインシェル（PATH実行ファイル・pwsh関数・シェルエイリアス解決）経由で起動するが、
 * `exec`によるシェル置換はしない。エージェント終了後に終了コードをexitMarkerFileへ書き出す
 * 後続ステップを実行する必要があるため（buildLoginShellExecArgsはシェルをエージェントプロセスに
 * 完全に置き換えるため、終了コード捕捉のような後続処理を挟めない。PR #103 Review Manager指摘）。
 *
 * @param {string[]} agentCmdArgs
 * @param {string} exitMarkerFile 終了コードを書き出す先
 * @param {string} [platform=process.platform]
 * @returns {string[]}
 */
function buildVisiblePaneArgs(agentCmdArgs, exitMarkerFile, platform = process.platform) {
  if (platform === 'win32') {
    const escapedArgs = agentCmdArgs.map(a => `'${a.replace(/'/g, "''")}'`).join(' ');
    const escapedMarker = exitMarkerFile.replace(/'/g, "''");
    // ネイティブ実行ファイルの終了コードは $LASTEXITCODE に入る（codexはネイティブexe）。
    const command = `& ${escapedArgs}; Set-Content -LiteralPath '${escapedMarker}' -Value $LASTEXITCODE -NoNewline`;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    return ['pwsh', '-NoLogo', '-EncodedCommand', encoded];
  }
  const escapedMarker = exitMarkerFile.replace(/'/g, "'\\''");
  return ['bash', '-lc', `"$0" "$@"; echo $? > '${escapedMarker}'`, ...agentCmdArgs];
}

/**
 * 可視ペイン（wezterm split-pane）でエージェントを起動する。
 * spawnSyncによる同期ブロックが使えないため、完了検知はエージェントが終了コードを書き出す
 * exitMarkerFileの生成をポーリングする（outputFileの生成だけでは、findingsを早期に書き出した後も
 * ペインが動き続けているケースを完了と誤判定してしまう。PR #103 Review Manager指摘）。
 * WEZTERM_PANEが無い、またはペイン分割に失敗した場合はnullを返す（呼び出し側でheadlessにフォールバック）。
 * タイムアウト時は孤児プロセス化を防ぐためペインを明示的に強制終了する。
 *
 * @param {string[]} agentArgs
 * @param {string} cwd
 * @param {string} outputFile RMが書き出すfindings JSONのパス（終了コード確認後に存在確認する）
 * @param {(msg: string) => void} log
 * @returns {{status: number}|null}
 */
function runAgentVisible(agentArgs, cwd, outputFile, log) {
  const paneId = process.env.WEZTERM_PANE;
  if (!paneId) {
    log('reviewManagerVisible=true ですが WEZTERM_PANE が未設定のため headless にフォールバックします');
    return null;
  }

  const exitMarkerFile = `${outputFile}.exitcode`;
  try { fs.unlinkSync(exitMarkerFile); } catch {}

  const paneArgs = buildVisiblePaneArgs(agentArgs, exitMarkerFile);
  const split = spawnSync('wezterm', [
    'cli', '--no-auto-start', 'split-pane', '--bottom',
    '--cwd', cwd, '--pane-id', paneId, '--', ...paneArgs,
  ], { encoding: 'utf8' });

  if (split.status !== 0) {
    log(`wezterm split-pane 失敗: ${(split.stderr || '').trim()} — headlessにフォールバックします`);
    return null;
  }
  const newPaneId = (split.stdout || '').trim();
  log(`可視ペイン(${newPaneId})でエージェントを起動しました`);

  const start = Date.now();
  while (!fs.existsSync(exitMarkerFile)) {
    if (Date.now() - start > VISIBLE_POLL_TIMEOUT_MS) {
      log(`可視ペイン実行がタイムアウトしました（${VISIBLE_POLL_TIMEOUT_MS}ms）— ペインを強制終了します`);
      try {
        const kill = spawnSync('wezterm', ['cli', '--no-auto-start', 'kill-pane', '--pane-id', newPaneId], { encoding: 'utf8' });
        if (kill.status !== 0) log(`kill-pane 失敗: ${(kill.stderr || '').trim()}`);
      } catch (e) { log(`kill-pane 例外: ${e.message}`); }
      return { status: 1 };
    }
    sleepSync(VISIBLE_POLL_INTERVAL_MS);
  }

  let exitStatus = 1;
  try {
    const parsed = parseInt(fs.readFileSync(exitMarkerFile, 'utf8').trim(), 10);
    if (Number.isFinite(parsed)) exitStatus = parsed;
  } catch (e) { log(`exit marker 読み取り失敗: ${e.message}`); }
  try { fs.unlinkSync(exitMarkerFile); } catch {}

  if (exitStatus !== 0) {
    log(`可視ペインのエージェントが異常終了しました（exit ${exitStatus}）`);
    return { status: exitStatus };
  }
  if (!fs.existsSync(outputFile)) {
    log(`可視ペインのエージェントは正常終了しましたが RM output が見つかりません: ${outputFile}`);
    return { status: 1 };
  }
  return { status: 0 };
}

/**
 * メインスレッドで安全に使える同期スリープ。Atomics.waitはメインスレッドで
 * TypeErrorを投げうるため使わず、子プロセスのsetTimeoutをspawnSyncで待つ
 * （PR #103 Review Manager指摘）。
 * @param {number} ms
 */
function sleepSync(ms) {
  spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${Number(ms)})`]);
}

module.exports = {
  resolveMode, buildPrompt, digestText, writeRunMetadata,
  setupReviewWorktree, teardownReviewWorktree,
  runAgentHeadless, runAgentVisible, buildVisiblePaneArgs,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--mode', '--brief-file']);

  // exitFlagMiss（値欠落）を先に判定する。未消費の値トークンが rest に残るため、
  // それがたまたま "--help" と一致すると後段の hasHelpFlag が誤検出しうる。
  // 値欠落は常にエラー優先（フェイルクローズ）とする。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  const modeArg = values['--mode'];
  const briefFileArg = values['--brief-file'];
  const [pr, repo, workspace] = rest;

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
      directedBrief = resolveTextInput({ filePath: briefFileArg });
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
    // 専用worktree（とそのブランチ・専用ref）はレビュー完了後に必ず除去する。
    // setupReviewWorktree に到達していなくても teardown は安全（各ステップが失敗を許容する）。
    // log() 自体が失敗しうる状態（ghDir未作成等）でも finally 内の他ステップを止めないよう、
    // 例外は無視できるlogに差し替える。
    try {
      teardownReviewWorktree(workspace, pr, (msg) => { try { log(msg); } catch {} });
    } catch {}
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

    // Review Manager（Codex）はメインワークスペースを直接触らせず、専用worktree内でのみ動かす。
    // PRのdiffが外部由来の入力であるため、無制限の書き込み権限をメインワークスペースに
    // 持たせない（Issue #101）。
    let reviewWtDir;
    try {
      reviewWtDir = setupReviewWorktree(workspace, pr, log);
    } catch (e) {
      log(`review worktree のセットアップに失敗しました: ${e.message}`);
      exitCode = 1;
      reviewWtDir = null;
    }

    if (reviewWtDir === null) {
      // すでに exitCode=1 を設定済み。下の agentConfig 分岐に進まない。
    } else {
      const worktreeGhDir = path.join(reviewWtDir, '.gh-maestro');
      fs.mkdirSync(worktreeGhDir, { recursive: true });
      // Codexが実際に書き込むOUTPUTは専用worktree配下に限定する。
      // メインワークスペース側の outputFile（review-publisher.js が読む正式な場所）へは、
      // Codex終了後にこのスクリプト自身（サンドボックス外）がコピーする。
      const worktreeOutputFile = path.join(worktreeGhDir, `review-manager-${pr}.json`);

      // WORKSPACE はCodex自身に伝える実行場所であるため、隔離用に作成したreviewWtDirを渡す
      // （メインワークスペースを渡すとIssue #101の隔離が無効化される。PR #103 Review Manager指摘）。
      fs.writeFileSync(promptFile, buildPrompt({ pr, repo, workspace: reviewWtDir, outputFile: worktreeOutputFile, mode, directedBrief }), 'utf8');

      const skill = 'gh-maestro-reviewer';
      const skillMap = resolveSkillAgentMap({ workspace });
      const agentId = skillMap[skill] ?? 'codex';
      const homedir = process.env.HOME || process.env.USERPROFILE || '';
      const agentConfig = resolveAgentConfig(agentId, { workspace, homedir });

      // resolveAgentConfig の結果（config.json のユーザー上書きを含む）をそのまま使う。
      // headless実行専用の引数は agent-defaults.json 側の execArgs に持たせ、
      // {workspace} プレースホルダは専用worktreeの実パスに置換する（インラインでの
      // 設定丸ごと上書きはしない。PR #91 Review Manager指摘）。
      // 解決失敗（config.json のtypo等）は安全側に倒して中断する（fail-closed-safety-guardsルール）。
      if (!agentConfig) {
        log(`エージェント "${agentId}" の設定を解決できません（agent-defaults.json / config.json を確認してください）`);
        exitCode = 1;
      } else {
        const extraArgs = (agentConfig.execArgs ?? agentConfig.extraArgs ?? [])
          .map(a => a.replace(/\{workspace\}/g, reviewWtDir));

        const agentArgs = buildAgentCommandArgs({ ...agentConfig, extraArgs }, {
          promptFile,
          shortPrompt: `Read ${promptFile.replace(/\\/g, '/')} and execute it.`,
          systemPromptText: `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。`,
        });

        const visible = resolveReviewManagerVisible({ workspace, homedir });
        log(`spawning (visible=${visible}) ${agentArgs.join(' ')}`);
        const result = (visible && runAgentVisible(agentArgs, reviewWtDir, worktreeOutputFile, log))
          || runAgentHeadless(agentArgs, reviewWtDir);

        if (result.error) log(`spawn error: ${result.error.message}`);
        if (result.stdout) log(result.stdout);
        if (result.stderr) log(result.stderr);
        log(`${agentArgs[0]} exited with status ${result.status}`);

        if (result.status !== 0) {
          exitCode = result.status ?? 1;
        } else if (!fs.existsSync(worktreeOutputFile)) {
          log(`RM output not found: ${worktreeOutputFile}`);
          exitCode = 1;
        } else {
          fs.copyFileSync(worktreeOutputFile, outputFile);
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
      }
    }
  } finally {
    cleanup();
  }
  process.exit(exitCode);
}
