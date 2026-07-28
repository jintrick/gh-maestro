#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('./child-process');
const { buildAgentCommandArgs } = require('./agent-launch');
const { worktreeAdd, worktreeRemove, worktreePrune } = require('./git-worktree');
const { linkNodeModules } = require('./link-node-modules');
const { unlinkJunctions } = require('./unlink-junctions');
const { resolveAgentConfig, resolveSkillAgentMap } = require('./shared/resolve-config');
const {
  assertValidPr, reviewArtifactPath,
  reviewWorktreeBranchName, reviewWorktreeFetchRef, reviewWorktreeDir,
} = require('./shared/review-manager-paths');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

const USAGE = `run-review-manager.js — Review Managerをheadless起動してPRレビューを実行する

Usage: node run-review-manager.js <PR> <REPO> <WORKSPACE>

Arguments:
  <PR>         レビュー対象の PR 番号
  <REPO>       GitHub リポジトリ(owner/repo)
  <WORKSPACE>  ワークスペースの絶対パス

このスクリプトは通常 start-review-manager.js から detach 起動される内部エンドポイント。
3幹（Correctness/Resilience & Security/Maintainability）全てについて独立した
サブエージェントを並列に起動する。観点を絞り込む判断はReview Manager自身がPR diffを
見た上で行う（skills/gh-maestro-reviewer/SKILL.md参照）。`;

/**
 * @param {{pr: string, repo: string, workspace: string, outputFile: string}} params
 * @returns {string}
 */
function buildPrompt({ pr, repo, workspace, outputFile }) {
  const toUnix = p => p.replace(/\\/g, '/');
  return `gh-maestro-reviewerスキルを発動し、Review ManagerとしてPRレビューを実行してください。

PR=${pr}
REPO=${repo}
WORKSPACE=${toUnix(workspace)}
OUTPUT=${toUnix(outputFile)}

必ず以下を守ってください。
- GitHubへ投稿しない
- 採否判断しない
- 3観点のReviewerを独立に並列spawnする
- Reviewerには該当する観点別基準ファイルを読ませる
- 最終結果はOUTPUTのJSONだけに書き出す
`;
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

  // node_modules をメインワークスペースへjunctionリンクする（spawn-worker.js と同じ扱い）。
  // これが無いと worktree 内にモジュールが存在せず、Review Manager がプロジェクトの
  // ツール（tsx 等）を起動した時点で MODULE_NOT_FOUND になる。
  // リンクは best-effort——失敗してもレビュー自体は続行できるため、ログに残して進む。
  const nmResult = linkNodeModules(dir, workspace);
  for (const p of nmResult.linked) log(`node_modules junction 作成: ${p}`);
  for (const p of nmResult.missing) log(`[要対応] node_modules junction 作成に失敗: ${p}`);

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

  // 削除の前に node_modules junction を外す。junction を張ったまま再帰削除すると、
  // リンク先（メインワークスペースの node_modules）まで巻き込んで壊しうる
  // （.claude/rules/symlink-tree-walk-safety.md。remove-worker.js も同じ順序で行う）。
  try {
    unlinkJunctions(dir, (msg) => log(msg));
  } catch (e) {
    log(`junction 除去で例外: ${e.message.split('\n')[0]}`);
  }

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
 * Review Manager用の非対話起動argvを組み立てる。
 * 通常ワーカー用のプロンプト配送を維持したまま、execPromptDeliveryがあればRMだけで使う。
 *
 * @param {object} agentConfig
 * @param {{reviewWtDir: string, promptFile: string, skill: string}} options
 * @returns {string[]}
 */
function buildReviewManagerAgentArgs(agentConfig, { reviewWtDir, promptFile, skill }) {
  const extraArgs = (agentConfig.execArgs ?? agentConfig.extraArgs ?? [])
    .map(a => a.replace(/\{workspace\}/g, reviewWtDir));

  return buildAgentCommandArgs({
    ...agentConfig,
    extraArgs,
    promptDelivery: agentConfig.execPromptDelivery ?? agentConfig.promptDelivery,
    promptFlag: agentConfig.execPromptFlag ?? agentConfig.promptFlag,
  }, {
    promptFile,
    shortPrompt: `Read ${promptFile.replace(/\\/g, '/')} and execute it.`,
    systemPromptText: `orchestratorです。${skill}スキルを発動し、指示に従って作業を開始してください。`,
  });
}

/**
 * headless でエージェントを起動し、完了まで同期ブロックする。
 *
 * 標準出力/標準エラーはファイル記述子として logFile へ直接リダイレクトする。
 * これによりRM自身の発言（どの観点をどう判断・除外したか等）が**実行中から逐次**
 * ログに残り、完了を待たずに追跡できる（`Get-Content -Wait` / Monitor）。
 *
 * 以前は出力をメモリにバッファして完了後にまとめて書いていたため、実行中は何も
 * 見えなかった。パイプ（Tee-Object / tee）は使わない——非対話execモードのcodex/agyと
 * 非互換で本番クラッシュを起こした実績がある（Issue #150）。fdリダイレクトはシェルの
 * 文字列パイプライン層を通らないため、その障害も文字化けも構造的に起こらない。
 *
 * spawnSync のままなので呼び出し元は従来どおり完了を同期待ちできる。
 *
 * @param {string[]} agentArgs
 * @param {string} cwd
 * @param {string} logFile 標準出力/標準エラーの追記先
 * @returns {{status: number|null, error?: Error}}
 */
function runAgentHeadless(agentArgs, cwd, logFile) {
  const fd = fs.openSync(logFile, 'a');
  try {
    return spawnSync(agentArgs[0], agentArgs.slice(1), {
      cwd,
      env: process.env,
      // stdin は 'ignore' に固定する。TTYが無い状態で継承すると入力待ちでハングしうる
      // （codex exec は起動時に stdin を読む。実機確認済み）。
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  buildPrompt,
  setupReviewWorktree, teardownReviewWorktree,
  buildReviewManagerAgentArgs, runAgentHeadless,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { rest, exitFlagMiss } = parseFlags(argv, []);

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

  const ghDir = path.join(workspace, '.gh-maestro');
  const lockFile = reviewArtifactPath(ghDir, pr, '.running');
  const logFile = reviewArtifactPath(ghDir, pr, '.log');
  const outputFile = reviewArtifactPath(ghDir, pr, '.json');
  const promptFile = path.join(os.tmpdir(), `review-manager-prompt-${pr}-${Date.now()}.md`);

  function log(msg) {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  }

  function cleanup() {
    try { fs.unlinkSync(promptFile); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
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
    // logFile は worker-logs/ 配下（workerLogPath と共通のディレクトリ）で ghDir とは別なので、
    // ghDir とは別に存在を保証する。
    fs.mkdirSync(path.dirname(logFile), { recursive: true });

    // lock ファイルに自PIDを記録（起動元 launcher のPIDを上書き）。
    // launcher (start-review-manager.js) は detach 後すぐに終了するため、
    // 子プロセスである run-review-manager.js 自身が lock を所有・更新する。
    // これにより isLockValid が正しく稼働中プロセスのPIDを確認できる。
    fs.writeFileSync(lockFile, String(process.pid));

    log(`run-review-manager started pr=${pr} repo=${repo}`);

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
      fs.writeFileSync(promptFile, buildPrompt({ pr, repo, workspace: reviewWtDir, outputFile: worktreeOutputFile }), 'utf8');

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
        const agentArgs = buildReviewManagerAgentArgs(agentConfig, {
          reviewWtDir,
          promptFile,
          skill,
        });

        log(`spawning ${agentArgs.join(' ')}`);
        // 標準出力/標準エラーは同じ .log へfdで直接リダイレクトされ、実行中から逐次書かれる。
        // 完了後にまとめて log() へ書き戻す必要はない（以前はメモリにバッファしていたため、
        // 実行中はRMが何をしているか一切見えなかった）。
        const result = runAgentHeadless(agentArgs, reviewWtDir, logFile);

        if (result.error) log(`spawn error: ${result.error.message}`);
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
