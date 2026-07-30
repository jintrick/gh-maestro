#!/usr/bin/env node
'use strict';

// finalize-review.js — coverage ledgerとジョブ実行結果を受け取り、完全性ゲートを
// 検証した上で、正式findings JSONのatomic write（completeモード）または
// 不完全レビューのプレーンコメント投稿（incompleteモード）を行う。
// 判断を一切加えない機械的な集約器。
//
// Usage:
//   node finalize-review.js --results <path> --mode complete --output <path> [--workspace <path>]
//   node finalize-review.js --results <path> --mode incomplete [--workspace <path>]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('./child-process');
const { parseFlags, hasHelpFlag } = require('./shared/workspace');

// ── 定数 ────────────────────────────────────────────────────────────────────────

const ALL_LEAF_IDS = Object.freeze([
  'correctness/logic-invariants',
  'correctness/api-contract',
  'correctness/concurrency',
  'resilience-security/failure-recovery',
  'resilience-security/hostile-input',
  'maintainability/structure-naming',
  'maintainability/test-quality',
]);

const TRUNK_TO_LEAVES = Object.freeze({
  'Correctness': ['correctness/logic-invariants', 'correctness/api-contract', 'correctness/concurrency'],
  'Resilience & Security': ['resilience-security/failure-recovery', 'resilience-security/hostile-input'],
  'Maintainability': ['maintainability/structure-naming', 'maintainability/test-quality'],
});

const VALID_ASPECTS = new Set(['Correctness', 'Maintainability', 'Resilience & Security']);

const USAGE = `finalize-review.js — 完全性ゲート検証後、正式findings JSON書き出しまたは不完全コメント投稿

Usage:
  node finalize-review.js --results <path> --mode complete --output <path> [--workspace <path>]
  node finalize-review.js --results <path> --mode incomplete [--workspace <path>]

Options:
  --results <path>     run-review-jobs.js が出力した結果JSONファイルのパス
  --mode <mode>        complete | incomplete
  --output <path>      completeモード時の出力先JSONファイルパス（incompleteでは不要）
  --workspace <path>   ワークスペースの絶対パス（デフォルト: cwd）

Output:
  complete 終了コード0: 完全性ゲート通過。OUTPUTにfindings.jsonをatomic write
  complete 終了コード1: 完全性ゲート失敗（不完全なためcompleteモードでは書き出さない）
  incomplete 終了コード0: プレーンコメント投稿＋センチネルファイル作成
  incomplete 終了コード1: 投稿失敗
  終了コード2: 入力不正`;

// ── 完全性ゲート ──────────────────────────────────────────────────────────────

/**
 * 7葉の完全な会計を機械的に検証する。
 * 判断を一切加えず、欠落・重複・未割当・結果欠如のみを検出する。
 *
 * @param {object} coverageLedger
 * @param {object[]} jobResults
 * @returns {{passed: boolean, failures: string[], successLeaves: string[], failedLeaves: string[], excludedLeaves: string[]}}
 */
function checkCompleteness(coverageLedger, jobResults) {
  const failures = [];

  // 1. 全7葉がledger上に出現するか
  const ledgerLeaves = new Map();
  const adoptedLeaves = new Set();
  const excludedLeaves = [];

  if (!coverageLedger || !Array.isArray(coverageLedger.leaves)) {
    return { passed: false, failures: ['coverage_ledger.leaves is missing or not an array'], successLeaves: [], failedLeaves: [], excludedLeaves: [] };
  }

  for (const leaf of coverageLedger.leaves) {
    if (ledgerLeaves.has(leaf.id)) {
      failures.push(`duplicate leaf in ledger: ${leaf.id}`);
    }
    ledgerLeaves.set(leaf.id, leaf);

    if (leaf.decision === 'adopted') {
      adoptedLeaves.add(leaf.id);
    } else if (leaf.decision === 'excluded') {
      excludedLeaves.push(leaf.id);
    }
  }

  for (const id of ALL_LEAF_IDS) {
    if (!ledgerLeaves.has(id)) {
      failures.push(`leaf ${id} is missing from coverage ledger`);
    }
  }

  // 2. excluded leaf に rationale があるか
  for (const id of excludedLeaves) {
    const leaf = ledgerLeaves.get(id);
    if (!leaf || typeof leaf.rationale !== 'string' || !leaf.rationale.trim()) {
      failures.push(`excluded leaf ${id}: rationale is required`);
    }
  }

  // 3. 全 adopted leaf が少なくとも1つの success ジョブに割り当てられているか
  const successLeaves = new Set();
  const failedLeaves = new Set();
  const attemptedLeaves = new Set();

  for (const jr of jobResults) {
    for (const lid of (jr.leaf_ids || [])) {
      attemptedLeaves.add(lid);
      if (jr.status === 'success') {
        successLeaves.add(lid);
      } else {
        failedLeaves.add(lid);
      }
    }
  }

  for (const id of adoptedLeaves) {
    if (!attemptedLeaves.has(id)) {
      failures.push(`adopted leaf ${id} is not assigned to any job result`);
    } else if (failedLeaves.has(id) && !successLeaves.has(id)) {
      failures.push(`adopted leaf ${id} has only failed job results`);
    }
  }

  // 4. 3幹すべてについて、配下の全葉が adopted+success または excluded で追跡できるか
  for (const [trunk, leaves] of Object.entries(TRUNK_TO_LEAVES)) {
    for (const lid of leaves) {
      const isExcluded = excludedLeaves.includes(lid);
      const isSuccess = successLeaves.has(lid);
      if (!isExcluded && !isSuccess) {
        failures.push(`trunk "${trunk}" leaf ${lid} is neither excluded nor successfully reviewed`);
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    successLeaves: [...successLeaves],
    failedLeaves: [...failedLeaves],
    excludedLeaves,
  };
}

/**
 * 全ジョブのfindingsを集約し、スキーマ検証用のペイロードを構築する。
 *
 * @param {object} results
 * @returns {{pr: number, repo: string, headRefOid: string, findings: object[]}}
 */
function aggregateFindings(results) {
  const allFindings = [];
  for (const jr of results.jobs) {
    if (jr.status === 'success' && Array.isArray(jr.findings)) {
      allFindings.push(...jr.findings);
    }
  }
  return {
    pr: results.manifest_ref.pr,
    repo: results.manifest_ref.repo,
    headRefOid: results.manifest_ref.headRefOid,
    findings: allFindings,
  };
}

/**
 * 集約後のpayloadをreview-findings-schema.jsonで検証する。
 *
 * @param {object} payload
 * @param {string} workspace
 * @returns {{valid: boolean, errors: string[]}}
 */
function validatePayload(payload, workspace) {
  const schemaPath = path.join(workspace, 'scripts', 'review-findings-schema.json');
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (e) {
    return { valid: false, errors: [`schema load failed: ${e.message}`] };
  }

  // 簡易JSON Schema検証（run-review-manager.js の _validateAgainstSchema と同じロジック）
  const errors = _validateAgainstSchema(payload, schema);
  return { valid: errors.length === 0, errors };
}

/**
 * 簡易JSON Schema検証。
 * @param {*} value
 * @param {object} schema
 * @param {string} path_
 * @returns {string[]}
 */
function _validateAgainstSchema(value, schema, path_ = '') {
  const errors = [];

  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path_}: expected object`);
      return errors;
    }
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in value)) errors.push(`${path_}: missing required '${field}'`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${path_}: unexpected field '${key}'`);
      }
    }
    if (schema.properties) {
      for (const [key, ps] of Object.entries(schema.properties)) {
        if (key in value) {
          errors.push(..._validateAgainstSchema(value[key], ps, path_ ? `${path_}.${key}` : key));
        }
      }
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path_}: expected array`);
      return errors;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path_}: expected >= ${schema.minItems} items`);
    }
    if (schema.items && typeof schema.items === 'object') {
      for (let i = 0; i < value.length; i++) {
        errors.push(..._validateAgainstSchema(value[i], schema.items, `${path_}[${i}]`));
      }
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path_}: expected string`);
    else if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path_}: string too short (min ${schema.minLength})`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${path_}: invalid enum value '${value}'`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path_}: expected integer`);
    else if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${path_}: below minimum ${schema.minimum}`);
    }
  }

  return errors;
}

// ── atomic write ──────────────────────────────────────────────────────────────

/**
 * findings JSONをatomicに書き出す（staging → rename）。
 *
 * @param {object} payload
 * @param {string} outputPath
 * @returns {{success: boolean, error?: string}}
 */
function atomicWrite(payload, outputPath) {
  const dir = path.dirname(outputPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  const rand = Math.random().toString(36).slice(2, 8);
  const stagingPath = path.join(dir, `.staging-${path.basename(outputPath)}.${process.pid}-${Date.now()}-${rand}`);

  try {
    fs.writeFileSync(stagingPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(stagingPath, outputPath);
    return { success: true };
  } catch (e) {
    try { fs.unlinkSync(stagingPath); } catch {}
    return { success: false, error: e.message };
  }
}

// ── プレーンコメント生成 ──────────────────────────────────────────────────────

/**
 * 不完全レビュー用のプレーンコメント本文を生成する。
 *
 * @param {object} results
 * @param {object} gateResult checkCompletenessの戻り値
 * @returns {string}
 */
function buildIncompleteComment(results, gateResult) {
  const lines = [
    '## ⚠️ 不完全レビュー',
    '',
    'このレビューは**不完全**です。以下の理由により、正式なReview Managerレビュー完了とはみなされません。',
    '',
    '---',
    '',
    '### 成功した葉',
    '',
  ];

  const successLeaves = gateResult.successLeaves;
  if (successLeaves.length > 0) {
    for (const lid of successLeaves) {
      const jobResult = results.jobs.find(jr => (jr.leaf_ids || []).includes(lid) && jr.status === 'success');
      const findingCount = jobResult && Array.isArray(jobResult.findings) ? jobResult.findings.length : 0;
      lines.push(`- **${lid}**: ${findingCount}件の所見`);
    }
  } else {
    lines.push('（なし）');
  }

  lines.push('');
  lines.push('### 失敗/未完了の葉');
  lines.push('');

  const failedLeaves = gateResult.failedLeaves;
  if (failedLeaves.length > 0) {
    for (const lid of failedLeaves) {
      const jobResult = results.jobs.find(jr => (jr.leaf_ids || []).includes(lid));
      const errorMsg = jobResult ? jobResult.error || 'unknown error' : 'no job result found';
      lines.push(`- **${lid}**: ${errorMsg}`);
    }
  }

  // adoptedだがjobsに現れなかった葉
  const missingLeaves = [];
  if (results.coverage_ledger && Array.isArray(results.coverage_ledger.leaves)) {
    for (const leaf of results.coverage_ledger.leaves) {
      if (leaf.decision === 'adopted' && !successLeaves.includes(leaf.id) && !failedLeaves.includes(leaf.id)) {
        missingLeaves.push(leaf.id);
      }
    }
  }
  if (missingLeaves.length > 0) {
    for (const lid of missingLeaves) {
      lines.push(`- **${lid}**: ジョブに割り当てられていません`);
    }
  }

  lines.push('');
  lines.push('### 除外した葉');
  lines.push('');

  const excludedLeaves = gateResult.excludedLeaves;
  if (excludedLeaves.length > 0 && results.coverage_ledger && Array.isArray(results.coverage_ledger.leaves)) {
    for (const lid of excludedLeaves) {
      const leaf = results.coverage_ledger.leaves.find(l => l.id === lid);
      const rationale = leaf ? leaf.rationale : '（理由不明）';
      lines.push(`- **${lid}**: ${rationale}`);
    }
  } else {
    lines.push('（なし）');
  }

  lines.push('');
  lines.push('### 完全性ゲート不合格理由');
  lines.push('');

  for (const f of gateResult.failures) {
    lines.push(`- ${f}`);
  }

  lines.push('');
  lines.push('---');
  lines.push(`_最終更新: ${new Date().toISOString()}_`);

  return lines.join('\n');
}

// ── センチネル ────────────────────────────────────────────────────────────────

/**
 * 不完全レビュー完了を示すセンチネルファイルを作成する。
 * run-review-manager.js の監督ループがこのファイルを検出して
 * 「OUTPUT不在だがレビューは終了した」ことを認識する。
 *
 * @param {string} workspace
 * @param {number} pr
 */
function writeSentinel(workspace, pr) {
  const sentinelPath = path.join(workspace, '.gh-maestro', `review-manager-${pr}.incomplete`);
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify({
      pr,
      reason: 'incomplete-review',
      completed_at: new Date().toISOString(),
    }), 'utf8');
    return sentinelPath;
  } catch {
    return null;
  }
}

// ── メイン ─────────────────────────────────────────────────────────────────────

/**
 * @param {string} resultsPath
 * @param {'complete'|'incomplete'} mode
 * @param {string|null} outputPath
 * @param {string} workspace
 * @returns {Promise<{ok: boolean, summary: object}>}
 */
async function finalizeReview(resultsPath, mode, outputPath, workspace) {
  // 1. results読み込み
  let resultsRaw;
  try {
    resultsRaw = fs.readFileSync(resultsPath, 'utf8');
  } catch (e) {
    return { ok: false, summary: { error: `results read failed: ${e.message}` } };
  }

  let results;
  try {
    results = JSON.parse(resultsRaw);
  } catch (e) {
    return { ok: false, summary: { error: `results JSON parse failed: ${e.message}` } };
  }

  if (!results.coverage_ledger || !Array.isArray(results.jobs)) {
    return { ok: false, summary: { error: 'results missing coverage_ledger or jobs' } };
  }

  // 2. 完全性ゲート
  const gateResult = checkCompleteness(results.coverage_ledger, results.jobs);

  if (mode === 'complete') {
    // ── complete モード ──
    if (!gateResult.passed) {
      return {
        ok: false,
        summary: {
          error: 'completeness gate failed',
          failures: gateResult.failures,
          successLeaves: gateResult.successLeaves,
          failedLeaves: gateResult.failedLeaves,
          excludedLeaves: gateResult.excludedLeaves,
        },
      };
    }

    // 3. findings集約
    const payload = aggregateFindings(results);

    // 4. スキーマ検証
    const validation = validatePayload(payload, workspace);
    if (!validation.valid) {
      return { ok: false, summary: { error: 'schema validation failed', details: validation.errors } };
    }

    // 5. atomic write
    if (!outputPath) {
      return { ok: false, summary: { error: 'output path is required for complete mode' } };
    }

    const writeResult = atomicWrite(payload, outputPath);
    if (!writeResult.success) {
      return { ok: false, summary: { error: `atomic write failed: ${writeResult.error}` } };
    }

    return {
      ok: true,
      summary: {
        mode: 'complete',
        outputPath,
        totalFindings: payload.findings.length,
      },
    };
  } else {
    // ── incomplete モード ──
    const pr = results.manifest_ref.pr;
    const repo = results.manifest_ref.repo;

    // 3. プレーンコメント生成・投稿
    const commentBody = buildIncompleteComment(results, gateResult);

    let commentUrl = null;
    let commentError = null;

    try {
      const ghResult = spawnSync('gh', [
        'pr', 'comment', String(pr),
        '--repo', repo,
        '--body', commentBody,
      ], { encoding: 'utf8', stdio: 'pipe' });

      if (ghResult.status === 0) {
        commentUrl = (ghResult.stdout || '').trim();
      } else {
        commentError = (ghResult.stderr || '').toString().trim();
      }
    } catch (e) {
      commentError = e.message;
    }

    // 4. センチネルファイル作成
    const sentinelPath = writeSentinel(workspace, pr);

    if (!commentUrl && commentError) {
      return {
        ok: false,
        summary: {
          error: `plane comment post failed: ${commentError}`,
          sentinelPath,
        },
      };
    }

    return {
      ok: true,
      summary: {
        mode: 'incomplete',
        commentUrl,
        sentinelPath,
        gateFailures: gateResult.failures,
      },
    };
  }
}

// ── テスト用エクスポート ──────────────────────────────────────────────────────
module.exports = {
  checkCompleteness,
  aggregateFindings,
  validatePayload,
  _validateAgainstSchema,
  buildIncompleteComment,
  writeSentinel,
  finalizeReview,
  ALL_LEAF_IDS,
  TRUNK_TO_LEAVES,
};

// ── CLIエントリポイント ────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const valueFlags = ['--results', '--mode', '--output', '--workspace'];
    const { rest, exitFlagMiss } = parseFlags(args, valueFlags, ['--help', '-h']);

    if (exitFlagMiss) {
      console.error(USAGE);
      process.exit(2);
    }

    if (hasHelpFlag(rest) || rest.length === 0) {
      console.log(USAGE);
      process.exit(0);
    }

    const getArg = (name) => {
      const idx = rest.indexOf(name);
      return idx >= 0 && idx + 1 < rest.length ? rest[idx + 1] : null;
    };

    const resultsPath = getArg('--results');
    const mode = getArg('--mode');
    const outputPath = getArg('--output');
    const workspace = getArg('--workspace') || process.cwd();

    if (!resultsPath || !mode || (mode === 'complete' && !outputPath)) {
      console.error(USAGE);
      process.exit(2);
    }

    if (mode !== 'complete' && mode !== 'incomplete') {
      console.error('--mode must be "complete" or "incomplete"');
      process.exit(2);
    }

    const result = await finalizeReview(resultsPath, mode, outputPath || null, workspace);

    if (!result.ok) {
      console.error(JSON.stringify(result.summary));
      process.exit(1);
    }

    console.log(JSON.stringify(result.summary));
    process.exit(0);
  })();
}
