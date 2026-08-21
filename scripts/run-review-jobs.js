#!/usr/bin/env node
'use strict';

// run-review-jobs.js — RMが書いた実行manifestを受け取り、指定されたジョブをheadless起動し、
// 全ジョブの完了を待って結果を永続化する。判断を一切加えない機械的な実行器。
//
// 使い方（フラグ・終了コード）は --help（下記 USAGE 定数）を参照。
//
// manifest は RM（Review Manager）が書き出したJSONファイル。coverage_ledger（7葉の
// 採用/除外会計）と jobs（実行するジョブのリスト）を含む。
// このスクリプトは manifest の機械的検証のみを行い、葉の関連性判断・ジョブ分割方針
// の妥当性は検証しない（それらはRMの責務）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('./child-process');
const { writeSentinel, finalizeReview } = require('./finalize-review');
const { reviewArtifactPath } = require('./shared/review-manager-paths');
const { atomicWriteJson } = require('./shared/atomic-write');
const { buildAgentCommandArgs } = require('./agent-launch');
const { buildLoginShellExecArgs } = require('./agent-exec');
const { resolveAgentConfig, resolveSkillAgentMap, validateNonInteractiveTokens } = require('./shared/resolve-config');
const { workerLogPath } = require('./shared/headless-launch');
const { readJsonFile } = require('./shared/json-file');
const { parseFlags } = require('./shared/workspace');
const {
  ALL_LEAF_IDS,
  TRUNK_TO_LEAVES,
  VALID_ASPECTS,
  VALID_SEVERITIES,
  FINDING_REQUIRED_FIELDS,
  reviewFilesForLeaves,
} = require('./shared/review-aspects');
const { managedRoot } = require('./shared/storage-layout');

// ── 定数 ────────────────────────────────────────────────────────────────────────
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per job
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes total
// 1レビュー周回あたりに run-review-jobs.js が実行計画を実行できる合計回数
// （初回＋再試行）。council の MAX_PARTICIPANT_ATTEMPTS（=2）と同じ「合計試行回数」
// セマンティクス: attempt 1,2 は許容し、attempt 3 を拒否する。
const MAX_REVIEW_ATTEMPTS = 2;

// テストでは spawn を注入し、NODE_TEST_CONTEXT 下で実プロセスを起動しない。
let _spawn = spawn;

const USAGE = `run-review-jobs.js — RMの実行manifestに従いレビュージョブをheadless起動する

Usage: node run-review-jobs.js --manifest <path> --results <path> --pr <N> --repo <owner/repo> --gh-dir <path> [--workspace <path>]

Options:
  --manifest <path>    RMが書き出した実行manifestのJSONファイルパス
  --results <path>     ジョブ実行結果を書き出すJSONファイルパス
  --pr <N>             必須。通知先PR番号（検証前の起動コンテキスト。正整数のみ受理）
  --repo <owner/repo>  必須。リポジトリ（検証前の起動コンテキスト）。manifestの読み込み・
                       解析に失敗した場合でも通知先として使う（manifest.repo は取れないため）
  --gh-dir <path>      必須。メインワークスペースの .gh-maestro ディレクトリ（再試行カウンタの
                       永続化先。RMのworktreeではなくメインワークスペース側を渡すこと）
  --workspace <path>   ワークスペースの絶対パス（デフォルト: cwd）
  --job-timeout <ms>   ジョブごとのタイムアウト（ms、デフォルト: 600000）
  --total-timeout <ms> 全体のタイムアウト（ms、デフォルト: 1800000）

Output:
  終了コード0: 全ジョブ成功。resultsファイルに結果を書き出し
  終了コード1: 一部ジョブ失敗。resultsファイルに成功・失敗を含む全結果を書き出し
  終了コード2: manifest不正・読み込み/解析失敗または起動失敗
    manifestの機械検証・読み込み・解析の失敗は、エラー内容（検証エラー・読み込みエラー・
    パースエラー）をPRへのプレーンコメントとして投稿し、.incompleteセンチネルを書き出した
    上で終了コード2で終了する（不完全レビューとして通知済み。レビュー担当は再試行しない。
    書き直し判断はオーケストレーターが行う）。
    投稿に失敗した場合は成功センチネルを書かず notify-failed センチネルを書き、
    監督側が失敗（exit 1）として扱う。
  終了コード3: 再試行上限到達（MAX_REVIEW_ATTEMPTS）。ジョブを起動せず、既存の不完全レビュー
    経路（finalize-review.js --mode incomplete）でPRへプレーンコメント投稿と .incomplete
    センチネル作成を行った上で終了する（不完全レビューとして通知済み。レビュー担当は再試行
    しない。再レビューの判断はオーケストレーターが行う）。`;

// ── manifest検証 ───────────────────────────────────────────────────────────────

/**
 * manifestの機械的整合性を検証する。
 * RMの判断（葉の関連性・ジョブ分割方針）の妥当性は検証しない。
 *
 * @param {object} manifest
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateManifest(manifest) {
  const errors = [];

  // トップレベル構造
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be a JSON object'] };
  }
  if (!Number.isInteger(manifest.pr) || manifest.pr < 1) {
    errors.push('pr must be a positive integer');
  }
  if (typeof manifest.repo !== 'string' || !manifest.repo) {
    errors.push('repo is required (non-empty string)');
  }
  if (typeof manifest.headRefOid !== 'string' || !manifest.headRefOid) {
    errors.push('headRefOid is required (non-empty string)');
  }
  if (Object.prototype.hasOwnProperty.call(manifest, 'acceptanceCriteria')) {
    if (!Array.isArray(manifest.acceptanceCriteria) || manifest.acceptanceCriteria.length === 0) {
      errors.push('acceptanceCriteria must be a non-empty array when present');
    } else if (manifest.acceptanceCriteria.some(item => typeof item !== 'string' || !item.trim())) {
      errors.push('acceptanceCriteria must contain only non-empty strings');
    }
  }

  // coverage_ledger 検証
  const ledger = manifest.coverage_ledger;
  if (!ledger || typeof ledger !== 'object' || !Array.isArray(ledger.leaves)) {
    errors.push('coverage_ledger.leaves must be an array');
  } else {
    const seenLeaves = new Set();
    const adoptedLeaves = new Set();

    for (const leaf of ledger.leaves) {
      if (!leaf || typeof leaf !== 'object') {
        errors.push('coverage_ledger.leaves: each entry must be an object');
        continue;
      }
      if (typeof leaf.id !== 'string' || !leaf.id) {
        errors.push('coverage_ledger.leaves: each entry must have a non-empty string id');
        continue;
      }
      if (!ALL_LEAF_IDS.includes(leaf.id)) {
        errors.push(`unknown leaf id: ${JSON.stringify(leaf.id)}`);
      }
      if (seenLeaves.has(leaf.id)) {
        errors.push(`duplicate leaf id in coverage_ledger: ${leaf.id}`);
      }
      seenLeaves.add(leaf.id);

      if (typeof leaf.trunk !== 'string' || !VALID_ASPECTS.has(leaf.trunk)) {
        errors.push(`leaf ${leaf.id}: invalid or missing trunk "${leaf.trunk}"`);
      }

      if (leaf.decision === 'adopted') {
        adoptedLeaves.add(leaf.id);
      } else if (leaf.decision === 'excluded') {
        if (typeof leaf.rationale !== 'string' || !leaf.rationale.trim()) {
          errors.push(`excluded leaf ${leaf.id}: rationale is required (non-empty string)`);
        }
      } else {
        errors.push(`leaf ${leaf.id}: decision must be "adopted" or "excluded", got ${JSON.stringify(leaf.decision)}`);
      }
    }

    // 7葉すべてが出現するか
    for (const id of ALL_LEAF_IDS) {
      if (!seenLeaves.has(id)) {
        errors.push(`leaf ${id} is missing from coverage_ledger`);
      }
    }

    // jobs 検証（ledgerの検証が通った場合のみ）
    if (errors.length === 0 && manifest.jobs) {
      validateJobs(manifest.jobs, adoptedLeaves, errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * jobs配列の機械的整合性を検証する。
 *
 * @param {object[]} jobs
 * @param {Set<string>} adoptedLeaves coverage_ledger上の採用葉集合
 * @param {string[]} errors エラー出力先（破壊的追加）
 */
function validateJobs(jobs, adoptedLeaves, errors) {
  if (!Array.isArray(jobs)) {
    errors.push('jobs must be an array');
    return;
  }
  if (jobs.length === 0) {
    errors.push('jobs must not be empty when adopted leaves exist');
    return;
  }

  const seenJobIds = new Set();
  const assignedLeaves = new Set();

  for (const job of jobs) {
    if (!job || typeof job !== 'object') {
      errors.push('jobs: each entry must be an object');
      continue;
    }
    if (typeof job.id !== 'string' || !job.id) {
      errors.push('jobs: each job must have a non-empty string id');
      continue;
    }
    if (seenJobIds.has(job.id)) {
      errors.push(`duplicate job id: ${job.id}`);
    }
    seenJobIds.add(job.id);

    if (!Array.isArray(job.leaf_ids) || job.leaf_ids.length === 0) {
      errors.push(`job ${job.id}: leaf_ids must be a non-empty array`);
    } else {
      for (const lid of job.leaf_ids) {
        if (typeof lid !== 'string' || !ALL_LEAF_IDS.includes(lid)) {
          errors.push(`job ${job.id}: unknown leaf id: ${JSON.stringify(lid)}`);
          continue;
        }
        if (!adoptedLeaves.has(lid)) {
          errors.push(`job ${job.id}: leaf_id "${lid}" is not in coverage_ledger adopted leaves`);
        }
        if (assignedLeaves.has(lid)) {
          errors.push(`leaf ${lid} is assigned to multiple jobs (${job.id} and another)`);
        }
        assignedLeaves.add(lid);
      }
    }

    if (typeof job.aspect !== 'string' || !VALID_ASPECTS.has(job.aspect)) {
      errors.push(`job ${job.id}: invalid or missing aspect "${job.aspect}"`);
    }
    for (const field of ['trunk_dir', 'leaf_files']) {
      if (Object.prototype.hasOwnProperty.call(job, field)) {
        errors.push(`job ${job.id}: ${field} is not supported; derive leaf paths from leaf_ids`);
      }
    }

    // retry_policy は Issue #273 で廃止。上限は固定の MAX_REVIEW_ATTEMPTS に置き換わった。
    // 残存する retry_policy は「設定が上限を変えるように見えて実際は常に無視される」という
    // 誤認を生むため、受理せず機械検証で拒否する（将来のRM/manifest生成側が誤って書いた
    // 場合も、ここで明確に失敗して気づける）。
    if (Object.prototype.hasOwnProperty.call(job, 'retry_policy')) {
      errors.push(`job ${job.id}: retry_policy is no longer supported (removed in Issue #273); the retry limit is now fixed at MAX_REVIEW_ATTEMPTS. Remove retry_policy from the manifest`);
    }
  }

  // 全 adopted leaf が少なくとも1つのジョブに割り当てられているか
  for (const lid of adoptedLeaves) {
    if (!assignedLeaves.has(lid)) {
      errors.push(`adopted leaf ${lid} is not assigned to any job`);
    }
  }
}

// ── 観点定義の正本解決 ────────────────────────────────────────────────────────

/**
 * 観点定義の正本ディレクトリを解決する。
 * 通常実行時は ~/.gh-maestro/skills/gh-maestro-reviewer （managedRoot() 準拠）のみを返す。
 * テスト時は options.reviewSkillsDir による注入を許可する。
 * （リポジトリ内ディレクトリへのフォールバックは、gh-maestro 自身のリポジトリにおいて
 * 審査対象PRを読んでしまうため行わない。環境変数による差し替えも行わない）。
 *
 * @param {object} [options]
 * @param {string} [options.reviewSkillsDir]
 * @returns {string}
 */
function resolveReviewSkillsDir(options = {}) {
  if (options && typeof options.reviewSkillsDir === 'string' && options.reviewSkillsDir) {
    return path.resolve(options.reviewSkillsDir);
  }
  return path.join(managedRoot(), 'skills', 'gh-maestro-reviewer');
}

/**
 * 正本ルートからの相対パスを解決する。パスは review-aspects.js のホワイトリストから
 * 導出されるが、ルート外へ出ないこともここで確認して防御を一箇所に集約する。
 *
 * @param {string} relativePath
 * @param {string} skillsDir
 * @returns {{ok: true, resolvedPath: string} | {ok: false, error: string}}
 */
function resolveCanonicalReviewPath(relativePath, skillsDir) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, error: `review file path must be a non-empty string: ${relativePath}` };
  }
  const root = path.resolve(skillsDir);
  const resolvedPath = path.resolve(root, relativePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolvedPath !== root && !resolvedPath.startsWith(rootPrefix)) {
    return { ok: false, error: `review file path escapes canonical root (${relativePath})` };
  }
  return { ok: true, resolvedPath };
}

function jobReviewFilePaths(job) {
  if (!Array.isArray(job.leaf_ids) || job.leaf_ids.length === 0) {
    throw new Error(`job ${job.id}: leaf_ids must be a non-empty array`);
  }
  let files;
  try {
    files = reviewFilesForLeaves(job.leaf_ids);
  } catch (e) {
    throw new Error(`job ${job.id}: ${e.message}`);
  }
  return {
    common: files[0],
    leaves: job.leaf_ids.map((id, index) => ({
      id,
      pre: files[index * 2 + 1],
      post: files[index * 2 + 2],
    })),
  };
}

function readCanonicalReviewFile(job, relativePath, skillsDir) {
  const resolved = resolveCanonicalReviewPath(relativePath, skillsDir);
  if (!resolved.ok) {
    return { ok: false, error: `job ${job.id}: ${resolved.error}` };
  }
  try {
    return {
      ok: true,
      value: { path: relativePath, content: fs.readFileSync(resolved.resolvedPath, 'utf8') },
    };
  } catch (e) {
    return {
      ok: false,
      error: `job ${job.id}: cannot read leaf file from canonical copy (${relativePath}): ${e.message}`,
    };
  }
}

/**
 * 担当葉の正本ファイルが揃っていることを、内容をプロンプトへ渡す前に検証する。
 * これにより、プロンプト生成後に必須の観点ファイル欠落で終わることを避ける。
 */
function validateCanonicalReviewFiles(job, skillsDir) {
  let paths;
  try {
    paths = jobReviewFilePaths(job);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const files = [paths.common, ...paths.leaves.flatMap(leaf => [leaf.pre, leaf.post])];
  for (const relativePath of files) {
    const resolved = resolveCanonicalReviewPath(relativePath, skillsDir);
    if (!resolved.ok) return { ok: false, error: `job ${job.id}: ${resolved.error}` };
    let fd;
    try {
      if (!fs.statSync(resolved.resolvedPath).isFile()) {
        throw new Error('not a regular file');
      }
      fd = fs.openSync(resolved.resolvedPath, 'r');
    } catch (e) {
      return {
        ok: false,
        error: `job ${job.id}: cannot read leaf file from canonical copy (${relativePath}): ${e.message}`,
      };
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }
  return { ok: true };
}

/**
 * 担当葉の共通・事前・事後の観点定義を正本から読む。
 */
function readJobLeaves(job, skillsDir) {
  let paths;
  try {
    paths = jobReviewFilePaths(job);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const read = (relativePath) => readCanonicalReviewFile(job, relativePath, skillsDir);
  const commonRes = read(paths.common);
  if (!commonRes.ok) return commonRes;
  const common = commonRes.value;

  const leaves = [];
  for (const leaf of paths.leaves) {
    const entry = { id: leaf.id };
    const preRes = read(leaf.pre);
    if (!preRes.ok) return preRes;
    entry.pre = preRes.value;
    const postRes = read(leaf.post);
    if (!postRes.ok) return postRes;
    entry.post = postRes.value;
    leaves.push(entry);
  }
  return { ok: true, common, leaves };
}

// ── ジョブプロンプト生成 ──────────────────────────────────────────────────────

function acceptanceCriteriaSection(manifest) {
  return Array.isArray(manifest.acceptanceCriteria) && manifest.acceptanceCriteria.length > 0
    ? `## 受け入れ条件

以下はReview Managerが対象Issueから忠実に列挙し、manifestに引き継いだ受け入れ条件です。判定の物差しとしてのみ使ってください。
要件そのものの是非を論じず、未実装の指摘に使わず、評価対象は従来どおり変更差分の中に限ってください。

${manifest.acceptanceCriteria.map(item => `- ${item}`).join('\n')}

`
    : '';
}

function findingsOutputSection(aspect, resultFile) {
  const resultPath = resultFile
    ? String(resultFile).replace(/\\/g, '/')
    : '(ジョブ起動時に指定された結果ファイルのパス)';
  return `## 出力形式

レビュー完了後、以下のJSON配列を標準出力ではなく、指定された結果ファイルへUTF-8で書き出してください。
結果ファイル: \`${resultPath}\`
**結果ファイルにはJSON以外の説明・Markdown・コメントを絶対に混ぜないでください。**
標準出力の内容は実行器から解釈されません。指摘がない場合も、結果ファイルへ空配列 \`[]\` を書き出してください。

\`\`\`json
[
  {
    "aspect": "${aspect}",
    "path": "src/foo.ts",
    "line_anchor": "await saveUser(user)",
    "context_before": "if (!user.id) throw new Error('missing id')",
    "context_after": "return user",
    "summary": "User persistence can report success before the write completes",
    "severity": "BLOCKER",
    "severity_rationale": "APIが成功を返した後に永続化が失敗するとデータ損失が発生するため",
    "body": "## 観測した事実\\n\\n...\\n\\n## 放置すると何が起きるか\\n\\n...\\n\\n## 修正の方向性\\n\\n...",
    "verified_references": ["src/foo.ts", "src/userRepository.ts"]
  }
]
\`\`\`

- \`aspect\`: 必ず \`"${aspect}"\` を設定してください
- \`line_anchor\`: PR head実ファイルに存在する連続したコード断片そのもの
- \`severity_rationale\`: 判定根拠を1行で記述
- \`body\`: 観測した事実・放置すると何が起きるか・修正の方向性を含める
- \`verified_references\`: 実際に確認したファイルパスの配列（1件以上必須)`;
}

function reviewEvidenceSection(job, manifest) {
  return `## レビュー対象

PR #${manifest.pr}
リポジトリ: ${manifest.repo}
HEAD: ${manifest.headRefOid}

## 入力証拠

作業ディレクトリはPR headにリセットされた専用worktreeです。
以下のdiffと変更ファイル一覧、およびmanifestに存在する受け入れ条件だけを入力として使用してください。
担当外の観点は評価しなくて構いません。

${acceptanceCriteriaSection(manifest)}### 変更ファイル一覧

${(manifest.changedFiles || []).map(f => `- ${f}`).join('\n') || '(情報なし)'}

### diff

(実際のdiffは作業ディレクトリ上で \`git diff\` またはファイル読み取りで確認してください)`;
}

function commonReviewRestrictions(resultFile) {
  const resultPath = resultFile
    ? String(resultFile).replace(/\\/g, '/')
    : '(ジョブ起動時に指定された結果ファイルのパス)';
  return `## 禁止事項

- 必要な裏取りは対象diffと関連コードに限定すること
- レビュー範囲を無制限に拡大しない
- ファイル書き込みは禁止。ただし、レビュー結果を指定された結果ファイル \`${resultPath}\` に書き出す場合だけ許可する
- GitHubへの投稿は禁止

## Severity判定規準

- \`BLOCKER\`: マージすると本番で実害が発生する（データ破損・クラッシュ・セキュリティ侵害・機能不全）
- \`MAJOR\`: 実害の直接発生はないが、放置コストが高い（再発性の高いバグ温床・保守困難化）
- \`SUGGESTION\`: 任意の改善提案
- 判定に迷う場合は低い方に倒す`;
}

/**
 * 単段のレビュー用プロンプトを生成する。post-review はプロンプトの後半へ置き、
 * 指摘を書き終える前に読まないことを文面で明示することで、確認順序を担保する。
 */
function buildJobPrompt(job, manifest, reviewWtDir, options = {}) {
  const skillsDir = resolveReviewSkillsDir(options);
  const leafRes = readJobLeaves(job, skillsDir);
  if (!leafRes.ok) throw new Error(leafRes.error);

  const preLeavesSection = leafRes.leaves.map(leaf =>
    `### ${leaf.id} — ${leaf.pre.path}\n\n${leaf.pre.content}`
  ).join('\n\n---\n\n');
  const postLeavesSection = leafRes.leaves.map(leaf =>
    `### ${leaf.id} — ${leaf.post.path}\n\n${leaf.post.content}`
  ).join('\n\n---\n\n');

  return `あなたは gh-maestro のレビューワーカーです。担当観点「${job.aspect}」について、
以下の事前指示を踏まえ、指定されたdiffを自由にレビューしてください。

## 担当観点

${job.aspect}

## 事前指示

### 全ジョブ共通

${leafRes.common.content}

### 担当葉

${preLeavesSection}

${reviewEvidenceSection(job, manifest)}

${commonReviewRestrictions(options.resultFile)}

まずdiffと関連コードを探索し、観測した事実に基づく指摘を書き終えてください。
指摘を書き終えるまで、post-review.mdを読むことを禁じます。以下にパスと内容が現れても参照してはいけません。
指摘を書き終えた後にだけpost-review.mdを読み、既に書いた指摘と照合してください。
照合で担当観点に該当する実際の問題の取りこぼしが見つかった場合だけ、追加の指摘を作成してください。

## 事後確認表（指摘を書き終えた後に読む）

${postLeavesSection}

${findingsOutputSection(job.aspect, options.resultFile)}`;
}

function readFindingsFile(resultFile, stage) {
  let findings;
  try {
    if (!fs.statSync(resultFile).isFile()) throw new Error('not a regular file');
    findings = readJsonFile(resultFile);
  } catch (e) {
    const kind = e instanceof SyntaxError ? 'result JSON parse failed' : 'result file read failed';
    throw new Error(`${stage}: ${kind} (${resultFile}): ${e.message}`);
  }

  if (!Array.isArray(findings)) throw new Error(`${stage}: output is not a JSON array`);
  const findingErrors = [];
  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i];
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      findingErrors.push(`finding[${i}] must be an object`);
      continue;
    }
    for (const field of FINDING_REQUIRED_FIELDS) {
      if (!(field in finding)) findingErrors.push(`finding[${i}].${field} is missing`);
    }
    if (finding.aspect && !VALID_ASPECTS.has(finding.aspect)) {
      findingErrors.push(`finding[${i}].aspect invalid: ${finding.aspect}`);
    }
    if (finding.severity && !VALID_SEVERITIES.has(finding.severity)) {
      findingErrors.push(`finding[${i}].severity invalid: ${finding.severity}`);
    }
  }
  if (findingErrors.length > 0) throw new Error(`${stage}: finding validation: ${findingErrors.join('; ')}`);
  return findings;
}

function runReviewProcess(agentArgs, reviewWtDir, stderrFd, childRef) {
  return new Promise((resolve) => {
    if (_spawn === spawn && process.env.NODE_TEST_CONTEXT) {
      resolve({ error: 'agent spawn refused during test execution; inject spawn for launch-path tests' });
      return;
    }
    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (childRef) childRef.child = null;
      resolve(result);
    };
    try {
      const shellArgs = buildLoginShellExecArgs(agentArgs, process.platform);
      child = _spawn(shellArgs[0], shellArgs.slice(1), {
        cwd: reviewWtDir,
        env: process.env,
        // stdout is deliberately ignored. Review results are read from the file
        // requested in the job prompt; parsing a mixed agent stream is unsafe.
        stdio: ['ignore', 'ignore', stderrFd],
      });
      if (!child || typeof child.on !== 'function') {
        finish({ error: 'spawn returned an invalid child process handle' });
        return;
      }
      if (childRef) childRef.child = child;
    } catch (e) {
      finish({ error: `spawn failed: ${e.message}` });
      return;
    }

    child.on('error', err => finish({ error: `agent process error: ${err.message}` }));
    child.on('close', code => finish({ code }));
  });
}

/**
 * 1ジョブを単一のheadlessエージェントプロセスで実行し、findingsを取得する。
 */
async function launchJobWorker(job, manifest, agentConfig, reviewWtDir, workspace, timeoutMs, childRef = null, options = {}) {
  const failed = (error) => ({
    jobId: job.id,
    status: 'failed',
    leaf_ids: job.leaf_ids,
    attempt: 1,
    error,
  });

  const tokenCheck = validateNonInteractiveTokens(agentConfig, agentConfig.execArgs ?? agentConfig.extraArgs);
  if (!tokenCheck.valid) {
    return failed(`agent "${agentConfig.id}" execArgs/extraArgs is missing non-interactive token(s): ${tokenCheck.missing.join(', ')} (check ~/.gh-maestro/config.json agents["${agentConfig.id}"].execArgs / extraArgs)`);
  }

  const promptDelivery = agentConfig.execPromptDelivery ?? agentConfig.promptDelivery;
  const promptFlag = agentConfig.execPromptFlag ?? agentConfig.promptFlag;
  if (!['flag', 'positional', 'system-prompt-file'].includes(promptDelivery)) {
    return failed(`agent "${agentConfig.id}" prompt delivery "${promptDelivery}" is not supported for headless review`);
  }
  if (promptDelivery === 'flag' && !promptFlag) {
    return failed(`agent "${agentConfig.id}" promptFlag is required for headless review`);
  }

  const skillsDir = resolveReviewSkillsDir(options);
  const fileCheck = validateCanonicalReviewFiles(job, skillsDir);
  if (!fileCheck.ok) return failed(fileCheck.error);

  const configuredArgs = agentConfig.execArgs ?? agentConfig.extraArgs;
  if (!Array.isArray(configuredArgs) || configuredArgs.some(arg => typeof arg !== 'string')) {
    return failed(`agent "${agentConfig.id}" execArgs/extraArgs must be an array of strings`);
  }

  let resultDir;
  try {
    resultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-job-result-'));
  } catch (e) {
    return failed(`result file setup failed: ${e.message}`);
  }
  const resultFile = path.join(resultDir, 'findings.json');
  const cleanupResultDir = () => {
    try { fs.rmSync(resultDir, { recursive: true, force: true }); } catch {}
  };

  let prompt;
  try {
    prompt = buildJobPrompt(job, manifest, reviewWtDir, { ...options, resultFile });
  } catch (e) {
    cleanupResultDir();
    return failed(e.message);
  }

  let logFile;
  try {
    logFile = workerLogPath(workspace, `review-job-${job.id}`, {
      ownerKind: 'job', ownerId: job.id, workerName: `review-job-${job.id}`,
    });
  } catch (e) {
    cleanupResultDir();
    return failed(`log file path failed: ${e.message}`);
  }
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch {}

  let stderrFd;
  try {
    stderrFd = fs.openSync(logFile, 'a');
  } catch (e) {
    cleanupResultDir();
    return failed(`log file open failed: ${e.message}`);
  }

  const promptFiles = new Set();
  let timeoutHandle;
  let timedOut = false;
  const promptFileFor = () => {
    const promptFile = path.join(os.tmpdir(), `review-job-${job.id}-review-${Date.now()}.md`);
    promptFiles.add(promptFile);
    return promptFile;
  };
  const writePrompt = (promptFile, text) => {
    try {
      fs.writeFileSync(promptFile, text, 'utf8');
      return null;
    } catch (e) {
      return `prompt file write failed: ${e.message}`;
    }
  };
  const cleanupPrompt = (promptFile) => {
    promptFiles.delete(promptFile);
    try { fs.unlinkSync(promptFile); } catch {}
  };
  const argsConfig = {
    ...agentConfig,
    extraArgs: configuredArgs
      .map(arg => arg.replace(/\{workspace\}/g, reviewWtDir)),
    promptDelivery,
    promptFlag,
  };
  const shortPrompt = (promptFile) => `Read ${promptFile.replace(/\\/g, '/')} and execute it.`;

  timeoutHandle = setTimeout(() => {
    timedOut = true;
    try { if (childRef && childRef.child) childRef.child.kill(); } catch {}
  }, timeoutMs);

  try {
    const promptFile = promptFileFor();
    const promptWriteError = writePrompt(promptFile, prompt);
    if (promptWriteError) return failed(promptWriteError);

    let agentArgs;
    try {
      agentArgs = buildAgentCommandArgs(argsConfig, {
        promptFile,
        shortPrompt: shortPrompt(promptFile),
        systemPromptText: `orchestratorです。レビューワーカーとして、担当観点「${job.aspect}」のレビューを実行してください。`,
      });
    } catch (e) {
      return failed(`review command construction failed: ${e.message}`);
    }

    const run = await runReviewProcess(agentArgs, reviewWtDir, stderrFd, childRef);
    cleanupPrompt(promptFile);
    if (run.error) return failed(`review process failed: ${run.error}`);
    if (timedOut) return failed('review job timeout (review process deadline reached)');
    if (run.code !== 0) {
      return failed(`review agent exited with code ${run.code}`);
    }

    let findings;
    try {
      findings = readFindingsFile(resultFile, 'review process');
    } catch (e) {
      return failed(e.message);
    }
    return {
      jobId: job.id,
      status: 'success',
      leaf_ids: job.leaf_ids,
      attempt: 1,
      findings,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    for (const promptFile of promptFiles) {
      try { fs.unlinkSync(promptFile); } catch {}
    }
    try { fs.closeSync(stderrFd); } catch {}
    cleanupResultDir();
  }
}

// ── manifest検証失敗の通知 ────────────────────────────────────────────────────
// 実行manifestの機械検証に失敗した場合、レビュー担当（RM）はこの事実を既存の
// 「不完全レビュー」経路（PRへのプレーンコメント + .incompleteセンチネル）に載せて
// 通知し、そのまま停止する。再試行はしない（ヘッドレス再試行はアンチパターン。
// AGENTS.md「Headless Retry Is An Anti-Pattern」/ Issue #271）。
// 計画の書き直し・再実行の判断はオーケストレーターが行う。

let _ghForTest = null;

/**
 * 通知先PR番号として利用可能な正整数を、候補の先頭から順に返す。
 *
 * manifest.pr はLLMが書いた実行計画の一部で信頼できない（0・欠落・文字列等が混入しうる）。
 * 通知・センチネルは必ずこの関数を経由して得たPR番号に固定し、通知処理が不正なprで
 * 例外に巻き込まれて中断しないようにする（Issue #271 レビュー指摘: 不正prで
 * reviewArtifactPath が throw し、コメントもセンチネルも書かれず黙って終わっていた）。
 *
 * @param {Array<number|string|undefined>} candidates 優先順に並べたpr候補（CLI --pr, manifest.pr 等）
 * @returns {string|null} 最初に見つかった正整数の文字列表現。無ければ null
 */
function resolveNotifyPr(candidates) {
  for (const p of candidates) {
    if (typeof p === 'number' && Number.isInteger(p) && p >= 1) return String(p);
    if (typeof p === 'string' && /^[1-9]\d*$/.test(p)) return p;
  }
  return null;
}

/**
 * 実行manifestの機械検証に失敗した旨を報告するプレーンコメント本文を生成する。
 * finalize-review.js の buildIncompleteComment とは別経路だが、同じ「PRへのプレーン
 * コメント」チャネルに載ることで、オーケストレーターの poll-reviews.js が検証失敗を
 * 確実に受け取れる（Issue #271: 検証失敗の内容がオーケストレーターへ届かなかった）。
 *
 * @param {object} manifest
 * @param {string[]} errors
 * @param {string} [notifyPr] 通知先PR番号（resolveNotifyPr の結果）。manifest.pr が不正でも
 *   コメント本文のPR参照は通知先を指すようにする。
 * @returns {string}
 */
function buildManifestValidationComment(manifest, errors, notifyPr) {
  const prLabel = notifyPr || manifest.pr;
  const lines = [
    '## ⚠️ 実行計画の機械検証に失敗しました（レビューは実行されていません）',
    '',
    `PR #${prLabel} の実行manifest（run-review-jobs.js）が機械検証に合格しなかったため、`,
    'レビュー担当はこの通知を行った上で停止しました。計画の書き直し・再実行は行いません。',
    '',
    '### 検証エラー',
    '',
  ];
  for (const e of errors) {
    lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('_検証失敗は自動通知です（run-review-jobs.js）。_');
  return lines.join('\n');
}

/**
 * センチネルファイルの reason を読む。JSONとして解釈できなければ null。
 * @param {string} sentinelPath
 * @returns {string|null}
 */
function readSentinelReason(sentinelPath) {
  try {
    const data = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    if (data && typeof data === 'object' && typeof data.reason === 'string') return data.reason;
  } catch {}
  return null;
}

/**
 * manifestの読み込み・JSONパースに失敗した旨を報告するプレーンコメント本文を生成する。
 * 検証失敗（buildManifestValidationComment）と同一の「PRへのプレーンコメント」チャネルに
 * 載ることで、オーケストレーターの poll-reviews.js が失敗を確実に受け取れる
 * （Issue #271: モデルが書くJSONの構文エラーは最も起きやすく、stderrのみでは黙って済む）。
 *
 * @param {'read'|'parse'} kind 読み込み失敗かJSONパース失敗か
 * @param {string} errorText エラーメッセージ。パース失敗時は SyntaxError のメッセージ
 *   （JSON.parse は壊れている位置を「in JSON at position N」として含む）をそのまま載せる
 * @param {string} manifestPath 対象のmanifestファイルパス
 * @param {string} [notifyPr] 通知先PR番号（CLI --pr 由来）
 * @returns {string}
 */
function buildManifestLoadFailureComment(kind, errorText, manifestPath, notifyPr) {
  const prLabel = notifyPr || '?';
  const [title, reasonLine] = kind === 'parse'
    ? ['実行計画のJSONを解析できませんでした', 'がJSONとして解析できなかった']
    : ['実行計画のmanifestを読み込めませんでした', 'が読み込めなかった'];
  const lines = [
    `## ⚠️ ${title}（レビューは実行されていません）`,
    '',
    `PR #${prLabel} の実行manifest（${manifestPath}）${reasonLine}ため、`,
    'レビュー担当はこの通知を行った上で停止しました。計画の書き直し・再実行は行いません。',
    '',
    '### エラー',
    '```',
    errorText,
    '```',
    '',
    '---',
    '_失敗は自動通知です（run-review-jobs.js）。_',
  ];
  return lines.join('\n');
}

/**
 * manifestの問題（検証失敗・読み込み失敗・JSONパース失敗）を、既存の「不完全レビュー」
 * 経路へ冪等に通知する。
 *
 * 1. 通知先PRを resolveNotifyPr で確定する（CLI --pr 必須化により本番では常に正整数。
 *    不正な場合は通知不能として例外で中断せず明確な失敗を返す）
 * 2. 「通知済みの不完全レビュー」センチネル（reason: 'incomplete-review'）が既にあれば
 *    同一PRで再投稿しない（冪等）。reason が notify-failed の場合は再投稿して回復を試みる
 * 3. commentBody をPRへのプレーンコメントとして投稿
 * 4. 投稿成功時のみ writeSentinel で「通知済み」センチネルを作成。
 *    投稿失敗時（認証切れ・ネットワーク障害等）は通知成功を偽装せず、postError と
 *    failureLabel / failureDetail を持つ notify-failed センチネルを作成する
 *    （監督側が非成功として観測する。冪等ガードは reason 'incomplete-review' のみスキップ
 *    するため、次回実行時に再投稿される＝回復経路。Issue #271 レビュー指摘: 失敗しても
 *    センチネルを書くため「通知済み」に見えて冪等ガードが再投稿を永久に塞いでいた）
 *
 * gh への投稿は _setGhForTest で注入可能。NODE_TEST_CONTEXT 検出時は実投稿を拒否する
 * （msg-send.js / gh-create-pr.js と同じ構造的ガード、Issue #202）。
 *
 * @param {{
 *   workspace: string,
 *   pr?: number|string,
 *   repo?: string,
 *   commentBody: string,
 *   failureLabel: string,
 *   failureDetail: string,
 * }} params  pr/repo は検証前の起動コンテキスト（CLI --pr / --repo）由来の信頼できる値。
 * @returns {{
 *   notifiable: boolean,
 *   skipped: boolean,
 *   posted: boolean,
 *   commentUrl: string|null,
 *   error: string|null,
 *   sentinelPath: string|null,
 * }}
 */
function notifyManifestProblem({ workspace, pr, repo, commentBody, failureLabel, failureDetail }) {
  const notifyPr = resolveNotifyPr([pr]);
  if (!notifyPr) {
    // 通知先PRを特定できない: コメントもprスコープのセンチネルも書けない。
    // reviewArtifactPath の例外で中断せず、明確な失敗を返す（run-review-managerが
    // 成果物なしの非ゼロ終了として観測する。失敗内容はstderrのsummary経由で届く）。
    // CLI --pr 必須化により本番では到達しない（プログラム呼び出し専用のフォールバック）。
    return {
      notifiable: false,
      skipped: false,
      posted: false,
      commentUrl: null,
      error: '通知先PRを特定できない（--pr が正整数でない）。PRへの通知を省略します',
      sentinelPath: null,
    };
  }

  const sentinelPath = reviewArtifactPath(path.join(workspace, '.gh-maestro'), notifyPr, '.incomplete');

  // 冪等: 「通知済み」センチネルのみスキップ対象。notify-failed は再投稿して回復を試みる
  if (fs.existsSync(sentinelPath) && readSentinelReason(sentinelPath) === 'incomplete-review') {
    return { notifiable: true, skipped: true, posted: false, commentUrl: null, error: null, sentinelPath };
  }

  const ghArgs = ['pr', 'comment', notifyPr, '--repo', repo, '--body', commentBody];

  let result;
  if (_ghForTest) {
    result = _ghForTest(ghArgs);
  } else if (process.env.NODE_TEST_CONTEXT) {
    result = { status: 1, stdout: '', stderr: 'テスト実行中（NODE_TEST_CONTEXT）のため、実際のGitHub投稿は行いません' };
  } else {
    const r = spawnSync('gh', ghArgs, { encoding: 'utf8', stdio: 'pipe' });
    result = { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  if (result.status === 0) {
    // 投稿成功時のみ「通知済み」センチネルを作成する
    const written = writeSentinel(workspace, notifyPr);
    return {
      notifiable: true,
      skipped: false,
      posted: true,
      commentUrl: String(result.stdout).trim(),
      error: null,
      sentinelPath: written || sentinelPath,
    };
  }

  // 投稿失敗: 通知成功を示すセンチネルは作らない。失敗内容を持つ notify-failed センチネルを
  // 作り、監督側（superviseReviewManager）が exit 0 の不完全完了ではなく失敗として観測できる
  // 状態を残す。冪等ガードは reason 'incomplete-review' のみスキップするため、次回実行時に
  // 再投稿される（回復経路）。
  const postError = String(result.stderr).trim() || `gh pr comment 失敗（status ${result.status}）`;
  const failedSentinel = writeSentinel(workspace, notifyPr, {
    reason: 'notify-failed',
    postError,
    failureLabel,
    failureDetail,
  });
  return {
    notifiable: true,
    skipped: false,
    posted: false,
    commentUrl: null,
    error: postError,
    sentinelPath: failedSentinel || null,
  };
}

/**
 * manifest検証失敗を notifyManifestProblem 経由で通知する（共通の投稿＋センチネルロジック）。
 *
 * @param {{
 *   manifest: object,
 *   workspace: string,
 *   errors: string[],
 *   pr?: number|string,
 *   repo?: string,
 * }} params  pr/repo は検証前の起動コンテキスト（CLI --pr / --repo）由来の信頼できる値。
 *   省略時は manifest.pr / manifest.repo にフォールバックする（プログラム呼び出し用。
 *   CLI必須化により本番では常にCLI値が渡る）。
 * @returns {{
 *   notifiable: boolean,
 *   skipped: boolean,
 *   posted: boolean,
 *   commentUrl: string|null,
 *   error: string|null,
 *   sentinelPath: string|null,
 * }}
 */
function notifyManifestValidationFailure({ manifest, workspace, errors, pr, repo }) {
  const notifyPr = resolveNotifyPr([pr, manifest.pr]);
  return notifyManifestProblem({
    workspace,
    pr: notifyPr,
    repo: repo || manifest.repo,
    commentBody: buildManifestValidationComment(manifest, errors, notifyPr),
    failureLabel: '検証エラー',
    failureDetail: errors.join(' | '),
  });
}

/**
 * テスト用: gh 呼び出しを注入する。実プロセスを0個spawnするテストから使う。
 * @param {(args: string[]) => {status: number, stdout?: string, stderr?: string}} impl
 */
function _setGhForTest(impl) {
  _ghForTest = impl;
}

let _finalizeReviewForTest = null;

/**
 * テスト用: finalizeReview（不完全レビュー経路）を注入する。実プロセスを0個spawnする
 * テストから使う（_setGhForTest と同じパターン。finalizeReview は内部で gh pr comment を
 * spawnSync するため、上限到達経路のテストでは注入で置き換える）。
 * @param {(resultsPath: string, mode: string, outputPath: string|null, workspace: string) => Promise<object>} impl
 */
function _setFinalizeReviewForTest(impl) {
  _finalizeReviewForTest = impl;
}

// ── 再試行カウンタ（決定的上限） ────────────────────────────────────────────────
// レビュージョブ再試行の回数上限を、モデルの自己申告ではなく決定的コードで強制する
// （Issue #273 / AGENTS.md「Headless Retry Is An Anti-Pattern」）。
//
// カウンタは「1レビュー周回あたりに run-review-jobs.js が実行計画を実行した回数」を
// ラウンド単位で記録する。RMの再試行は「全ジョブを含むmanifestの再実行」であるため、
// 回数の自然な単位はラウンド（=本スクリプトの呼び出し1回）である。job id は再実行ごとに
// 書き換わりうるが、ラウンド単位ならそれに依存しない。
//
// 永続化先はメインワークスペースの records/pr/<PR>/review/manager.retries.json
// （--gh-dir で渡されるメインワークスペースの .gh-maestro 配下）。results（実行ごと
// 全上書き）や manifest（モデルが書く＝モデルがリセットできる）ではなく、RM の worktree 外
// に置くことで「レビュー担当が書き換えたりリセットしたりできない場所」を満たす。
// リセットは監督側（run-review-manager.js）が新レビュー周回の開始（.running ロック作成）
// 時に resetRetryCount で行う。本スクリプト側では一切リセットしない。
//
// 上限到達時の出口は既存の不完全レビュー経路（finalize-review.js --mode incomplete）を
// 再利用する（新しい通知経路は作らない）。不完全コメントには最終実行で成功したジョブの
// 指摘内容が含まれる。

/**
 * 再試行カウンタファイルのパスを解決する。
 * @param {string} ghDir メインワークスペースの .gh-maestro ディレクトリ
 * @param {string|number} pr 正整数のPR番号
 * @returns {string}
 */
function retryCountPath(ghDir, pr) {
  return reviewArtifactPath(ghDir, pr, '.retries.json');
}

/**
 * 再試行カウンタを読む。
 *
 * ファイル不在（ENOENT）だけが「まだ1回も実行していない＝0回」という正常ケースで、
 * 読み取り失敗・JSON解析失敗・形式不正（attempts が非負整数でない）はフェイルクローズで
 * throw する。破損・読めないカウンタを 0 回として扱うと、このIssueが入れる決定的な歯止めが
 * その瞬間だけ無効（上限が事実上リセット）になる（Issue #267 / PR #268 の readWorkersRaw と
 * 同じ「不在と失敗の取り違え」を新しいコードに入れない。Windows の一時的な読み取り失敗は
 * 実在の事象: PR #251/#253/#259）。
 *
 * @param {string} ghDir
 * @param {string|number} pr
 * @returns {number} これまでの実行回数（非負整数）
 * @throws {Error} 読み取り失敗・JSON解析失敗・形式不正（上限を保証できないため）
 */
function readRetryCount(ghDir, pr) {
  const counterPath = retryCountPath(ghDir, pr);
  let raw;
  try {
    raw = fs.readFileSync(counterPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return 0; // 不在 = 初回実行
    }
    throw new Error(`再試行カウンタを読み取れませんでした: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`再試行カウンタが壊れています（JSON解析失敗）: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || !Number.isInteger(data.attempts) || data.attempts < 0) {
    throw new Error('再試行カウンタの形式が不正です（attempts が非負整数でない）');
  }
  return data.attempts;
}

/**
 * 再試行カウンタを1つ進めて永続化する。書き込み失敗は throw する（呼び出し元が
 * フェイルクローズで処理する。カウンタを進められないままジョブを実行すると、
 * 次回以降も同じ回数と判定され上限が効かなくなるため、黙って続行しない）。
 *
 * @param {string} ghDir
 * @param {string|number} pr
 * @returns {number} 更新後の実行回数
 */
function incrementRetryCount(ghDir, pr) {
  const next = readRetryCount(ghDir, pr) + 1;
  atomicWriteJson(retryCountPath(ghDir, pr), {
    pr: Number(pr),
    attempts: next,
    updated_at: new Date().toISOString(),
  });
  return next;
}

// ── カウンタ排他ロック ────────────────────────────────────────────────────────
// readRetryCount → incrementRetryCount の read-modify-write を直列化する。
//
// RM は1ターンで複数の run-review-jobs.js を並列に起動しうる（暴走時はまさにそうなる）ため、
// 「読んだ後に書く」が競合すると、両方が同じ回数を読んで同じ回数を書き、上限を素通りする。
// atomicWriteJson は個々のファイル置換を原子的にするだけで、read-modify-write 全体は
// 直列化しない（Issue #273 レビュー指摘）。wx フラグの原子的作成でロックを取り、
// read-modify-write 区間を直列化する。
//
// ロック保持ウィンドウは数ms。mtime が閾値（30秒）を超えたロックは、保持プロセスが
// クラッシュした stale ロックとみなして回収する。PID/startTime 照合（worker-lease.js）は
// 使わない——このロックは短命で、Windows の WMI 呼び出しを伴う高コストな
// getProcessStartTime を避けるため。

const RETRY_COUNT_LOCK_STALE_MS = 30 * 1000; // これを超えて残っていれば stale とみなす
const RETRY_COUNT_LOCK_WAIT_MS = 5 * 1000;   // ロック取得の最大待ち時間

// テスト用: ロック取得の最大待ち時間を上書きする（タイムアウト経路の回帰テストで短縮する）。
// null なら RETRY_COUNT_LOCK_WAIT_MS を使う。
let _retryCountLockWaitMs = null;
function _setRetryCountLockWaitMs(ms) {
  _retryCountLockWaitMs = ms;
}

const _sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function _sleepSync(ms) {
  Atomics.wait(_sleepBuffer, 0, 0, ms);
}

/**
 * 再試行カウンタの排他ロックファイルのパス。
 * @param {string} ghDir
 * @param {string} pr
 * @returns {string}
 */
function retryCountLockPath(ghDir, pr) {
  return retryCountPath(ghDir, pr) + '.lock';
}

/**
 * 再試行カウンタの排他ロックを取得する（wx フラグによる原子的作成）。
 * 既存ロックが stale（mtime 閾値超過）なら回収して再試行する。
 * @param {string} lockPath
 * @param {number} [maxWaitMs] 最大待ち時間（省略時は RETRY_COUNT_LOCK_WAIT_MS、テストで短縮可）
 * @throws {Error} ロックを取得できない（別プロセスが進行中、または stale ロックが残留）
 */
function acquireRetryCountLock(lockPath, maxWaitMs) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const waitMs = maxWaitMs ?? _retryCountLockWaitMs ?? RETRY_COUNT_LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (e.code !== 'EEXIST') throw e;
    }
    // 既存ロック: stale なら回収して再試行
    try {
      const st = fs.statSync(lockPath);
      if (Date.now() - st.mtimeMs > RETRY_COUNT_LOCK_STALE_MS) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
    } catch {
      // 既に消えた → 次の反復で取得を試みる
      continue;
    }
    _sleepSync(5);
  }
  throw new Error('再試行カウンタのロックを取得できませんでした（別プロセスが進行中か stale ロックが残留）');
}

/**
 * 再試行カウンタの排他ロックを解放する。
 * @param {string} lockPath
 */
function releaseRetryCountLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch {}
}

/**
 * 再試行上限を判定し、未達ならカウンタを進める（ゲート）。
 *
 * read-modify-write は acquireRetryCountLock の排他ロック下で行う（並列呼び出しでも
 * 上限を素通りしない）。ghDir / pr のどちらかが使えない場合（プログラム呼び出しで省略）は
 * ゲートを適用せず gated:false を返す。本番（CLI）では --gh-dir / --pr が必須のため
 * 常に適用される。
 *
 * ロック取得失敗（別プロセス進行中・権限等）は throw する（呼び出し元がフェイルクローズで
 * 拒否する。黙ってジョブを実行すると上限が効かないため）。
 *
 * @param {object} opts
 * @param {string|null} opts.ghDir メインワークスペースの .gh-maestro（nullならゲートしない）
 * @param {string|number|null} opts.pr
 * @returns {{gated: boolean, reason?: string, attempts?: number}}
 */
function applyRetryGate({ ghDir, pr }) {
  const notifyPr = resolveNotifyPr([pr]);
  if (!ghDir || !notifyPr) {
    return { gated: false };
  }
  const lockPath = retryCountLockPath(ghDir, notifyPr);
  acquireRetryCountLock(lockPath);
  try {
    const count = readRetryCount(ghDir, notifyPr);
    if (count >= MAX_REVIEW_ATTEMPTS) {
      return { gated: true, reason: 'retry-limit-reached', attempts: count };
    }
    return { gated: false, attempts: incrementRetryCount(ghDir, notifyPr) };
  } finally {
    releaseRetryCountLock(lockPath);
  }
}

// ── メイン ─────────────────────────────────────────────────────────────────────

/**
 * manifestに従って全ジョブを実行し、結果をファイルに書き出す。
 *
 * @param {string} manifestPath
 * @param {string} resultsPath
 * @param {string} workspace
 * @param {number} jobTimeoutMs
 * @param {number} totalTimeoutMs
 * @param {number|string} [pr] 検証前の起動コンテキスト（CLI --pr）由来の信頼できるPR番号。
 *   manifestの読み込み・解析・検証の失敗すべての通知先に使う（manifest.pr が不正・欠落でも
 *   通知を中断しない）。
 * @param {string} [repo] 検証前の起動コンテキスト（CLI --repo）由来のリポジトリ。
 *   manifestの読み込み・解析失敗時は manifest.repo が取れないため、これを使う。
 * @param {string} [ghDir] メインワークスペースの .gh-maestro ディレクトリ（再試行カウンタの
 *   永続化先）。CLI --gh-dir 由来。省略時（プログラム呼び出し）は再試行ゲートを適用しない。
 * @returns {Promise<{ok: boolean, summary: object}>}
 */
async function runJobsFromManifest(manifestPath, resultsPath, workspace, jobTimeoutMs, totalTimeoutMs, pr, repo, ghDir, options = {}) {
  // 1. manifest読み込み
  let manifest;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (e) {
    const errorText = e && e.message ? e.message : String(e);
    const kind = e instanceof SyntaxError ? 'parse' : 'read';
    const failureLabel = kind === 'parse' ? 'パースエラー' : '読み込みエラー';
    const errorPrefix = kind === 'parse' ? 'manifest JSON parse failed' : 'manifest read failed';
    // Issue #271: 読み込み失敗・JSONパース失敗のどちらも同じ通知経路へ流す。
    // pr/repo は検証前の起動コンテキストで、manifestが読めなくても通知に使える。
    const notification = notifyManifestProblem({
      workspace,
      pr,
      repo,
      commentBody: buildManifestLoadFailureComment(kind, errorText, manifestPath, pr),
      failureLabel,
      failureDetail: `${errorPrefix}: ${errorText} (path: ${manifestPath})`,
    });
    return { ok: false, summary: { error: `${errorPrefix}: ${errorText}`, notification } };
  }

  // 2. manifest検証
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    // Issue #271: 検証失敗を黙って終了せず、検証エラーをPRコメントと .incomplete センチネルで
    // 通知してから終了する。再試行はしない（ヘッドレス再試行はアンチパターン）。
    // pr は信頼できる起動コンテキスト（CLI --pr）で、manifest.pr が不正でも通知を中断しない。
    const notification = notifyManifestValidationFailure({ manifest, workspace, errors: validation.errors, pr });
    return {
      ok: false,
      summary: { error: `manifest validation failed`, details: validation.errors, notification },
    };
  }

  // 2.5 再試行上限ゲート（Issue #273）。
  // manifest検証（上）は「再試行しない」経路のため attempt を消費せず、ここから先の
  // ジョブ実行ループにだけ上限を掛ける。上限到達時はジョブを起動せず、既存の不完全
  // レビュー経路（finalizeReview --mode incomplete）で通知してから拒否する。
  let gate;
  try {
    gate = applyRetryGate({ ghDir, pr });
  } catch (e) {
    // カウンタの排他ロック取得・読み取り・インクリメントのいずれかに失敗。上限を保証できない
    // ままジョブを実行すると上限が効かなくなるため、フェイルクローズで拒否する。
    return { ok: false, summary: { error: `retry counter gate failed: ${e.message}` } };
  }
  if (gate.gated) {
    // 既存の不完全レビュー経路を再利用（新しい通知経路は作らない）。results は前回実行の
    // スナップショットが残っており、そこから成功ジョブの指摘内容を不完全コメントに載せる。
    // finalizeReview が失敗しても（results 欠落等）、上限はそのまま維持して拒否する。
    const incomplete = await (_finalizeReviewForTest || finalizeReview)(resultsPath, 'incomplete', null, workspace);
    return {
      ok: false,
      summary: {
        error: `retry limit reached (${MAX_REVIEW_ATTEMPTS} attempts max)`,
        retryLimitReached: true,
        attempts: gate.attempts,
        incomplete,
      },
    };
  }

  // 3. エージェント設定解決
  const skill = 'gh-maestro-reviewer';
  const skillMap = resolveSkillAgentMap({ workspace });
  const agentId = skillMap[skill] ?? 'codex';
  const homedir = process.env.HOME || process.env.USERPROFILE || '';
  const agentConfig = resolveAgentConfig(agentId, { workspace, homedir });

  if (!agentConfig) {
    return { ok: false, summary: { error: `agent config resolve failed for "${agentId}"` } };
  }

  const reviewWtDir = workspace; // ジョブワーカーは呼び出し元（RM）のworktreeを共有

  // 4. 全ジョブを並列起動
  // 子プロセスへの参照を保持し、total-timeout時に実際にkillできるようにする
  const activeChildren = [];
  const jobPromises = manifest.jobs.map(job => {
    const childRef = { child: null };
    activeChildren.push(childRef);
    return launchJobWorker(job, manifest, agentConfig, reviewWtDir, workspace, jobTimeoutMs, childRef, options);
  });

  // 全体タイムアウト: 締切到達時に残っている子プロセスを実際に終了させる
  let totalTimedOut = false;
  let totalTimerHandle;
  const totalTimer = new Promise((resolve) => {
    totalTimerHandle = setTimeout(() => {
      totalTimedOut = true;
      for (const ref of activeChildren) {
        try { if (ref.child) ref.child.kill(); } catch {}
      }
      resolve('total-timeout');
    }, totalTimeoutMs);
  });

  const allJobsPromise = Promise.all(jobPromises);
  const raceResult = await Promise.race([allJobsPromise, totalTimer]);
  if (!totalTimedOut && totalTimerHandle) clearTimeout(totalTimerHandle);

  let jobResults;
  if (raceResult === 'total-timeout') {
    // タイムアウト: 残存ジョブの結果を収集（killされたものは自然に解決される）
    const settled = await Promise.allSettled(jobPromises);
    jobResults = manifest.jobs.map((job, i) => {
      if (settled[i].status === 'fulfilled') return settled[i].value;
      return {
        jobId: job.id,
        status: 'failed',
        leaf_ids: job.leaf_ids,
        attempt: 1,
        error: 'job timeout (total deadline reached)',
      };
    });
  } else {
    jobResults = raceResult;
  }

  // 5. resultsを構築
  const results = {
    manifest_ref: {
      pr: manifest.pr,
      repo: manifest.repo,
      headRefOid: manifest.headRefOid,
    },
    coverage_ledger: manifest.coverage_ledger,
    jobs: jobResults,
    completed_at: new Date().toISOString(),
  };

  // 6. resultsを書き出し
  const resultsDir = path.dirname(resultsPath);
  try { fs.mkdirSync(resultsDir, { recursive: true }); } catch {}

  const allSuccess = jobResults.every(r => r.status === 'success');

  try {
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, summary: { error: `results write failed: ${e.message}` } };
  }

  return {
    ok: allSuccess,
    summary: {
      total_jobs: jobResults.length,
      success: jobResults.filter(r => r.status === 'success').length,
      failed: jobResults.filter(r => r.status === 'failed').length,
      resultsPath,
    },
  };
}

// ── テスト用エクスポート ──────────────────────────────────────────────────────
module.exports = {
  validateManifest,
  validateJobs,
  resolveReviewSkillsDir,
  resolveCanonicalReviewPath,
  validateCanonicalReviewFiles,
  readJobLeaves,
  buildJobPrompt,
  launchJobWorker,
  runJobsFromManifest,
  buildManifestValidationComment,
  buildManifestLoadFailureComment,
  notifyManifestValidationFailure,
  notifyManifestProblem,
  resolveNotifyPr,
  retryCountPath,
  retryCountLockPath,
  acquireRetryCountLock,
  releaseRetryCountLock,
  _setRetryCountLockWaitMs,
  readRetryCount,
  incrementRetryCount,
  applyRetryGate,
  MAX_REVIEW_ATTEMPTS,
  _setGhForTest,
  _setFinalizeReviewForTest,
  ALL_LEAF_IDS,
  TRUNK_TO_LEAVES,
  _setSpawn: (fn) => { _spawn = fn || spawn; },
};

// ── CLIエントリポイント ────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    let values, rest;
    try {
      ({ values, rest } = parseFlags(args, {
        flags: {
          '--pr': { required: true, hint: '検証前の起動コンテキストのPR番号' },
          '--repo': { required: true },
          '--gh-dir': { required: true },
          '--manifest': { required: true },
          '--results': { required: true },
          '--workspace': {},
          '--job-timeout': {},
          '--total-timeout': {},
        },
        booleans: ['--help', '-h'],
        // 未知フラグ・位置引数はパーサ側で拒否される（argv-parsing-pitfalls参照）。
        positionals: { min: 0, max: 0 },
      }));
    } catch (err) {
      if (err.name !== 'ArgsValidationError') throw err;
      if (err.helpRequested) {
        console.log(USAGE);
        process.exit(0);
      }
      for (const e of err.errors) console.error(`run-review-jobs: ${e.message}`);
      console.error(USAGE);
      process.exit(2);
    }

    if (values['--help'] || values['-h']) {
      console.log(USAGE);
      process.exit(0);
    }

    const manifestPath = values['--manifest'];
    const resultsPath = values['--results'];
    const workspace = values['--workspace'] || process.cwd();
    // --pr / --repo / --gh-dir は検証前の起動コンテキスト由来（RMのプロンプトに含まれる PR / REPO）。
    // 必須化し、作業を始める前にフェイルクローズで検証する。--pr は path traversal対策で
    // 正整数のみ受理（PR #84）。--repo は manifest の読み込み・解析に失敗した場合の通知先に
    // 必要で、欠落させると「起動時に必ず落ちる」呼び出し元が残るため必須にする（Issue #271）。
    // --gh-dir は再試行カウンタの永続化先（メインワークスペースの .gh-maestro、Issue #273）。
    // 欠落（キー不在）はパーサの required が検出するため、ここでは値の形式だけを検証する。
    // 空文字列（--repo "" 等）は required を満たしてしまうため trim で補足する。
    const pr = values['--pr'];
    if (!/^[1-9]\d*$/.test(pr)) {
      console.error(`--pr は正整数でなければなりません: ${pr}`);
      console.error(USAGE);
      process.exit(2);
    }
    const repo = values['--repo'];
    if (repo.trim() === '') {
      console.error('--repo は必須です（owner/repo）');
      console.error(USAGE);
      process.exit(2);
    }
    const ghDir = values['--gh-dir'];
    if (String(ghDir).trim() === '') {
      console.error('--gh-dir は必須です（メインワークスペースの .gh-maestro ディレクトリ）');
      console.error(USAGE);
      process.exit(2);
    }
    const jobTimeoutMs = values['--job-timeout'] ? parseInt(values['--job-timeout'], 10) : DEFAULT_JOB_TIMEOUT_MS;
    const totalTimeoutMs = values['--total-timeout'] ? parseInt(values['--total-timeout'], 10) : DEFAULT_TOTAL_TIMEOUT_MS;

    if (!manifestPath || !resultsPath) {
      console.error(USAGE);
      process.exit(2);
    }

    const result = await runJobsFromManifest(manifestPath, resultsPath, workspace, jobTimeoutMs, totalTimeoutMs, pr, repo, ghDir);

    if (!result.ok) {
      console.error(JSON.stringify(result.summary));
      // 再試行上限到達は既に不完全レビューとして通知済み。manifest検証失敗（exit 2）と
      // 区別するため専用の終了コード3で終了する（RMはこれを見て再試行しない）。
      process.exit(result.summary.retryLimitReached ? 3 : 2);
    }

    console.log(JSON.stringify(result.summary));
    process.exit(result.summary.failed > 0 ? 1 : 0);
  })();
}
