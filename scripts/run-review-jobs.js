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
const { parseFlags } = require('./shared/workspace');
const { ALL_LEAF_IDS, TRUNK_TO_LEAVES, VALID_ASPECTS, FINDING_REQUIRED_FIELDS } = require('./shared/review-aspects');

// ── 定数 ────────────────────────────────────────────────────────────────────────
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes per job
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes total
// 1レビュー周回あたりに run-review-jobs.js が実行計画を実行できる合計回数
// （初回＋再試行）。council の MAX_PARTICIPANT_ATTEMPTS（=2）と同じ「合計試行回数」
// セマンティクス: attempt 1,2 は許容し、attempt 3 を拒否する。
const MAX_REVIEW_ATTEMPTS = 2;

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
    if (typeof job.trunk_dir !== 'string' || !job.trunk_dir) {
      errors.push(`job ${job.id}: trunk_dir is required`);
    }
    if (!Array.isArray(job.leaf_files) || job.leaf_files.length === 0) {
      errors.push(`job ${job.id}: leaf_files must be a non-empty array`);
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

// ── ジョブプロンプト生成 ──────────────────────────────────────────────────────

/**
 * ジョブワーカーに渡すプロンプトを生成する。
 * RMがmanifestに含めたleaf_filesのパスから実際のファイル内容を読み取り、
 * プロンプトに埋め込む。
 *
 * @param {object} job
 * @param {object} manifest
 * @param {string} reviewWtDir
 * @returns {string}
 */
function buildJobPrompt(job, manifest, reviewWtDir) {
  const leafContents = job.leaf_files.map(lfPath => {
    const fullPath = path.resolve(reviewWtDir, lfPath);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      content = `[ファイルを読み取れませんでした: ${lfPath}]`;
    }
    return { path: lfPath, content };
  });

  const leavesSection = leafContents.map(lc =>
    `### ${lc.path}\n\n${lc.content}`
  ).join('\n\n---\n\n');

  const acceptanceSection = Array.isArray(manifest.acceptanceCriteria) && manifest.acceptanceCriteria.length > 0
    ? `## 受け入れ条件

以下はReview Managerが対象Issueから忠実に列挙し、manifestに引き継いだ受け入れ条件です。判定の物差しとしてのみ使ってください。
要件そのものの是非を論じず、未実装の指摘に使わず、評価対象は従来どおり変更差分の中に限ってください。

${manifest.acceptanceCriteria.map(item => `- ${item}`).join('\n')}

`
    : '';

  return `あなたは gh-maestro のレビューワーカーです。担当観点「${job.aspect}」について、
以下の葉ファイルの基準に従い、指定されたdiffをレビューしてください。

## 担当観点

${job.aspect}

## 担当葉ファイル

${leavesSection}

## レビュー対象

PR #${manifest.pr}
リポジトリ: ${manifest.repo}
HEAD: ${manifest.headRefOid}

## 入力証拠

作業ディレクトリはPR headにリセットされた専用worktreeです。
以下のdiffと変更ファイル一覧、およびmanifestに存在する受け入れ条件だけを入力として使用してください。
担当外の観点は評価しなくて構いません。

${acceptanceSection}
### 変更ファイル一覧

${(manifest.changedFiles || []).map(f => `- ${f}`).join('\n') || '(情報なし)'}

### diff

(実際のdiffは作業ディレクトリ上で \`git diff\` またはファイル読み取りで確認してください)

## 禁止事項

- \`npm test\` 等のスコープ限定なしの全件テスト実行は禁止
- \`npm run build\` 等の全体ビルド実行は禁止
- diffで変更された特定のテストファイルのみを対象にしたピンポイント実行（例: \`node --test tests/<file>.test.js\`）は許容
- 必要な裏取りは対象diffと関連コードに限定すること
- レビュー範囲を無制限に拡大しない
- ファイル書き込みは禁止
- GitHubへの投稿は禁止

## Severity判定規準

- \`BLOCKER\`: マージすると本番で実害が発生する（データ破損・クラッシュ・セキュリティ侵害・機能不全）
- \`MAJOR\`: 実害の直接発生はないが、放置コストが高い（再発性の高いバグ温床・保守困難化）
- \`SUGGESTION\`: 任意の改善提案
- 判定に迷う場合は低い方に倒す

## 出力形式

以下のJSON配列だけを標準出力に返してください。
**JSON以外の説明・Markdown・コメントを絶対に混ぜないでください。**
指摘がない場合は空配列 \`[]\` を返してください。

\`\`\`json
[
  {
    "aspect": "${job.aspect}",
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

- \`aspect\`: 必ず \`"${job.aspect}"\` を設定してください
- \`line_anchor\`: PR head実ファイルに存在する連続したコード断片そのもの
- \`severity_rationale\`: 判定根拠を1行で記述
- \`body\`: 観測した事実・放置すると何が起きるか・修正の方向性を含める
- \`verified_references\`: 実際に確認したファイルパスの配列（1件以上必須）
`;
}

// ── ジョブ起動・結果収集 ──────────────────────────────────────────────────────

/**
 * 1ジョブをheadless起動し、標準出力からfindingsを取得する。
 *
 * @param {object} job
 * @param {object} manifest
 * @param {object} agentConfig
 * @param {string} reviewWtDir
 * @param {string} workspace
 * @param {number} timeoutMs
 * @returns {Promise<{jobId: string, status: 'success'|'failed', leaf_ids: string[], attempt: number, findings?: object[], error?: string}>}
 */
function launchJobWorker(job, manifest, agentConfig, reviewWtDir, workspace, timeoutMs, childRef = null) {
  return new Promise((resolve) => {
    // 非対話化トークン検証（フェイルクローズ、Issue #163 Review Manager指摘）。
    // ジョブワーカーは execArgs ?? extraArgs を起動引数に使うため、execArgs を対話
    // モード化した上書きを extraArgs 側の検証だけで素通りしないよう、実際に使われる
    // 引数配列を検証してから spawn する（spawn 直前のガード。全ジョブが同じ
    // agentConfig を共有するため、1件でも欠落すれば全ジョブが起動せず失敗する）。
    const tokenCheck = validateNonInteractiveTokens(agentConfig, agentConfig.execArgs ?? agentConfig.extraArgs);
    if (!tokenCheck.valid) {
      resolve({
        jobId: job.id,
        status: 'failed',
        leaf_ids: job.leaf_ids,
        attempt: 1,
        error: `agent "${agentConfig.id}" execArgs/extraArgs is missing non-interactive token(s): ${tokenCheck.missing.join(', ')} (check ~/.gh-maestro/config.json agents["${agentConfig.id}"].execArgs / extraArgs)`,
      });
      return;
    }
    const promptText = buildJobPrompt(job, manifest, reviewWtDir);
    const promptFile = path.join(os.tmpdir(), `review-job-${job.id}-${Date.now()}.md`);

    try {
      fs.writeFileSync(promptFile, promptText, 'utf8');
    } catch (e) {
      resolve({
        jobId: job.id,
        status: 'failed',
        leaf_ids: job.leaf_ids,
        attempt: 1,
        error: `prompt file write failed: ${e.message}`,
      });
      return;
    }

    // エージェント引数を構築（run-review-manager.js の buildReviewManagerAgentArgs と同じパターン）
    const extraArgs = (agentConfig.execArgs ?? agentConfig.extraArgs ?? [])
      .map(a => a.replace(/\{workspace\}/g, reviewWtDir));

    const agentArgs = buildAgentCommandArgs({
      ...agentConfig,
      extraArgs,
      promptDelivery: agentConfig.execPromptDelivery ?? agentConfig.promptDelivery,
      promptFlag: agentConfig.execPromptFlag ?? agentConfig.promptFlag,
    }, {
      promptFile,
      shortPrompt: `Read ${promptFile.replace(/\\/g, '/')} and execute it.`,
      systemPromptText: `orchestratorです。レビューワーカーとして、担当観点「${job.aspect}」のレビューを実行してください。`,
    });

    const shellArgs = buildLoginShellExecArgs(agentArgs, process.platform);

    // ログファイル準備
    const logFile = workerLogPath(workspace, `review-job-${job.id}`, {
      ownerKind: 'job', ownerId: job.id, workerName: `review-job-${job.id}`,
    });
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
    } catch {}

    let stderrFd;
    try {
      stderrFd = fs.openSync(logFile, 'a');
    } catch (e) {
      try { fs.unlinkSync(promptFile); } catch {}
      resolve({
        jobId: job.id,
        status: 'failed',
        leaf_ids: job.leaf_ids,
        attempt: 1,
        error: `log file open failed: ${e.message}`,
      });
      return;
    }

    let child;
    try {
      child = spawn(shellArgs[0], shellArgs.slice(1), {
        cwd: reviewWtDir,
        env: process.env,
        stdio: ['ignore', 'pipe', stderrFd],
      });
      if (childRef) childRef.child = child;
    } catch (e) {
      try { fs.closeSync(stderrFd); } catch {}
      try { fs.unlinkSync(promptFile); } catch {}
      resolve({
        jobId: job.id,
        status: 'failed',
        leaf_ids: job.leaf_ids,
        attempt: 1,
        error: `spawn failed: ${e.message}`,
      });
      return;
    }

    const stdoutChunks = [];
    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(stderrFd); } catch {}
      try { fs.unlinkSync(promptFile); } catch {}

      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();

      if (code !== 0) {
        resolve({
          jobId: job.id,
          status: 'failed',
          leaf_ids: job.leaf_ids,
          attempt: 1,
          error: `agent exited with code ${code}${stdout ? ': ' + stdout.slice(0, 500) : ''}`,
        });
        return;
      }

      // stdoutからJSON配列を抽出（前後の非JSONテキストを許容）
      let findings;
      const jsonMatch = stdout.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        try {
          findings = JSON.parse(jsonMatch[0]);
        } catch {
          resolve({
            jobId: job.id,
            status: 'failed',
            leaf_ids: job.leaf_ids,
            attempt: 1,
            error: `JSON parse failed. stdout preview: ${stdout.slice(0, 500)}`,
          });
          return;
        }
      } else if (stdout === '[]' || stdout === '') {
        findings = [];
      } else {
        resolve({
          jobId: job.id,
          status: 'failed',
          leaf_ids: job.leaf_ids,
          attempt: 1,
          error: `no JSON array found in stdout. preview: ${stdout.slice(0, 500)}`,
        });
        return;
      }

      if (!Array.isArray(findings)) {
        resolve({
          jobId: job.id,
          status: 'failed',
          leaf_ids: job.leaf_ids,
          attempt: 1,
          error: 'output is not a JSON array',
        });
        return;
      }

      // 個別findingの形状検証
      const { VALID_SEVERITIES } = require('./shared/review-aspects');
      const findingErrors = [];
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i];
        for (const field of FINDING_REQUIRED_FIELDS) {
          if (!(field in f)) findingErrors.push(`finding[${i}].${field} is missing`);
        }
        if (f.aspect && !VALID_ASPECTS.has(f.aspect)) findingErrors.push(`finding[${i}].aspect invalid: ${f.aspect}`);
        if (f.severity && !VALID_SEVERITIES.has(f.severity)) findingErrors.push(`finding[${i}].severity invalid: ${f.severity}`);
      }

      if (findingErrors.length > 0) {
        resolve({
          jobId: job.id,
          status: 'failed',
          leaf_ids: job.leaf_ids,
          attempt: 1,
          error: `finding validation: ${findingErrors.join('; ')}`,
        });
        return;
      }

      resolve({
        jobId: job.id,
        status: 'success',
        leaf_ids: job.leaf_ids,
        attempt: 1,
        findings,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try { fs.closeSync(stderrFd); } catch {}
      try { fs.unlinkSync(promptFile); } catch {}
      resolve({
        jobId: job.id,
        status: 'failed',
        leaf_ids: job.leaf_ids,
        attempt: 1,
        error: `agent process error: ${err.message}`,
      });
    });
  });
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
 * 再試行カウンタを読む。欠落・壊れ・非整数は 0（初回実行）として扱う。
 * @param {string} ghDir
 * @param {string|number} pr
 * @returns {number} これまでの実行回数（非負整数）
 */
function readRetryCount(ghDir, pr) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(retryCountPath(ghDir, pr), 'utf8'));
  } catch {
    return 0;
  }
  if (data && typeof data === 'object' && Number.isInteger(data.attempts) && data.attempts >= 0) {
    return data.attempts;
  }
  return 0;
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
 * @throws {Error} ロックを取得できない（別プロセスが進行中、または stale ロックが残留）
 */
function acquireRetryCountLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + RETRY_COUNT_LOCK_WAIT_MS;
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
async function runJobsFromManifest(manifestPath, resultsPath, workspace, jobTimeoutMs, totalTimeoutMs, pr, repo, ghDir) {
  // 1. manifest読み込み
  let manifestRaw;
  try {
    manifestRaw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    // Issue #271: 読み込み失敗も通知経路へ流す（検証失敗と同じ「PRコメント＋センチネル」）。
    // pr/repo は検証前の起動コンテキスト（CLI --pr / --repo）で、manifestが読めなくても通知は可能。
    const loadError = e && e.message ? e.message : String(e);
    const notification = notifyManifestProblem({
      workspace,
      pr,
      repo,
      commentBody: buildManifestLoadFailureComment('read', loadError, manifestPath, pr),
      failureLabel: '読み込みエラー',
      failureDetail: `manifest read failed: ${loadError} (path: ${manifestPath})`,
    });
    return { ok: false, summary: { error: `manifest read failed: ${loadError}`, notification } };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (e) {
    // Issue #271: JSONパース失敗（モデルが書くJSONで最も起きやすい構文エラー）も通知経路へ流す。
    // SyntaxError のメッセージ（壊れている位置を含む）と manifest パスを通知本文に載せる。
    const parseError = e && e.message ? e.message : String(e);
    const notification = notifyManifestProblem({
      workspace,
      pr,
      repo,
      commentBody: buildManifestLoadFailureComment('parse', parseError, manifestPath, pr),
      failureLabel: 'パースエラー',
      failureDetail: `manifest JSON parse failed: ${parseError} (path: ${manifestPath})`,
    });
    return { ok: false, summary: { error: `manifest JSON parse failed: ${parseError}`, notification } };
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
    // カウンタの排他ロック取得に失敗（別プロセス進行中・権限・stale 残留）。上限を
    // 保証できないままジョブを実行すると上限が効かなくなるため、フェイルクローズで拒否する。
    return { ok: false, summary: { error: `retry counter lock failed: ${e.message}` } };
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
    return launchJobWorker(job, manifest, agentConfig, reviewWtDir, workspace, jobTimeoutMs, childRef);
  });

  // 全体タイムアウト: 締切到達時に残っている子プロセスを実際に終了させる
  let totalTimedOut = false;
  const totalTimer = new Promise((resolve) => {
    setTimeout(() => {
      totalTimedOut = true;
      for (const ref of activeChildren) {
        try { if (ref.child) ref.child.kill(); } catch {}
      }
      resolve('total-timeout');
    }, totalTimeoutMs);
  });

  const allJobsPromise = Promise.all(jobPromises);
  const raceResult = await Promise.race([allJobsPromise, totalTimer]);

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
  readRetryCount,
  incrementRetryCount,
  applyRetryGate,
  MAX_REVIEW_ATTEMPTS,
  _setGhForTest,
  _setFinalizeReviewForTest,
  ALL_LEAF_IDS,
  TRUNK_TO_LEAVES,
};

// ── CLIエントリポイント ────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const valueFlags = ['--manifest', '--results', '--workspace', '--pr', '--repo', '--gh-dir', '--job-timeout', '--total-timeout'];
    const { values, rest, exitFlagMiss } = parseFlags(args, valueFlags, ['--help', '-h']);

    if (exitFlagMiss) {
      console.error(USAGE);
      process.exit(2);
    }

    if (values['--help'] || values['-h']) {
      console.log(USAGE);
      process.exit(0);
    }

    // 未知の位置引数があればエラー
    if (rest.length > 0) {
      console.error(`unexpected positional arguments: ${rest.join(' ')}`);
      console.error(USAGE);
      process.exit(2);
    }

    const manifestPath = values['--manifest'];
    const resultsPath = values['--results'];
    const workspace = values['--workspace'] || process.cwd();
    // --pr / --repo は検証前の起動コンテキスト由来（RMのプロンプトに含まれる PR / REPO）。
    // 必須化し、作業を始める前にフェイルクローズで検証する。--pr は path traversal対策で
    // 正整数のみ受理（PR #84）。--repo は manifest の読み込み・解析に失敗した場合の通知先に
    // 必要で、欠落させると「起動時に必ず落ちる」呼び出し元が残るため必須にする（Issue #271）。
    // parseFlags は値なしフラグの値を null で返す（undefined ではない）ため、欠落判定は
    // どちらも null と undefined を同一視する（null.trim() の TypeError クラッシュ回避）。
    const pr = values['--pr'];
    if (pr == null || !/^[1-9]\d*$/.test(pr)) {
      console.error(pr == null
        ? '--pr は必須です（検証前の起動コンテキストのPR番号）'
        : `--pr は正整数でなければなりません: ${pr}`);
      console.error(USAGE);
      process.exit(2);
    }
    const repo = values['--repo'];
    if (repo == null || repo.trim() === '') {
      console.error('--repo は必須です（owner/repo）');
      console.error(USAGE);
      process.exit(2);
    }
    // --gh-dir は再試行カウンタの永続化先（メインワークスペースの .gh-maestro）。
    // --repo と同じく parseFlags は欠落を null で返すため、null.trim() の TypeError
    // クラッシュにしない（Issue #273 / PR #272 の --repo と同型のクラッシュ回避）。
    const ghDir = values['--gh-dir'];
    if (ghDir == null || String(ghDir).trim() === '') {
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
