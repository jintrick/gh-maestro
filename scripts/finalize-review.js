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
const { parseFlags } = require('./shared/workspace');
const { ALL_LEAF_IDS, TRUNK_TO_LEAVES, VALID_ASPECTS } = require('./shared/review-aspects');
const { _validateAgainstSchema } = require('./shared/json-schema');
const { atomicWriteJson } = require('./shared/atomic-write');
const { readJsonFile } = require('./shared/json-file');
const { reviewArtifactPath } = require('./shared/review-manager-paths');

// テスト用: gh 呼び出しを注入する（実プロセスを0個spawnするテストから使う。
// run-review-jobs.js の _setGhForTest と同じパターン。NODE_TEST_CONTEXT 検出時は
// 実投稿を拒否する）。
let _ghForTest = null;
function _setGhForTest(impl) {
  _ghForTest = impl;
}

const USAGE = `finalize-review.js — 完全性ゲート検証後、正式findings JSON書き出しまたは不完全コメント投稿

Usage:
  node finalize-review.js --results <path> --mode complete --output <path> [--integrated <path>] [--workspace <path>]
  node finalize-review.js --results <path> --mode incomplete [--workspace <path>]

Options:
  --results <path>     run-review-jobs.js が出力した結果JSONファイルのパス
  --mode <mode>        complete | incomplete
  --output <path>      completeモード時の出力先JSONファイルパス（incompleteでは不要）
  --integrated <path>  completeモードで、RMフェーズ2が重複を畳んだ統合findingsドラフトのパス
                       （省略時は全成功ジョブのfindingsを機械集約）。ドラフトは findings 配列を
                       持つJSON。エンベロープ（pr/repo/headRefOid）は results 由来で確定。
                       完全性ゲート・スキーマ検証・atomic writeは常に決定論的に行う。
  --workspace <path>   ワークスペースの絶対パス（デフォルト: cwd）

Output:
  complete 終了コード0: 完全性ゲート通過。OUTPUTにfindings.jsonをatomic write
  complete 終了コード1: 完全性ゲート失敗（不完全なためcompleteモードでは書き出さない）
  incomplete 終了コード0: プレーンコメント投稿＋センチネルファイル作成
  incomplete 終了コード1: 投稿失敗
  終了コード1: 入力不正`;

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

// ── atomic write ──────────────────────────────────────────────────────────────

/**
 * findings JSONをatomicに書き出す。実際の staging → rename は共有ヘルパー
 * atomicWriteJson に委譲し、本関数は呼び出し元契約の {success,error} を維持する
 * 薄いラッパー（Issue #232: atomic write の共有化）。
 *
 * @param {object} payload
 * @param {string} outputPath
 * @returns {{success: boolean, error?: string}}
 */
function atomicWrite(payload, outputPath) {
  try {
    atomicWriteJson(outputPath, payload);
    return { success: true };
  } catch (e) {
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

  // 最後の実行で成功したジョブの指摘内容（Issue #273: 再試行上限で打切りになっても、
  // 30分かけて集めた指摘を捨てない）。results は実行のたび全上書きされるため、ここに載るのは
  // 「最終スナップショット」で成功したジョブの findings のみ（前回成功・今回失敗したジョブの
  // findings は仕様上残らない）。body は複数行のMarkdownを含みうるため <details> で折りたたみ、
  // 本文のMarkdown整形を保ったまま保持する。
  const successFindings = [];
  for (const jr of results.jobs || []) {
    if (jr.status === 'success' && Array.isArray(jr.findings)) {
      successFindings.push(...jr.findings);
    }
  }
  if (successFindings.length > 0) {
    lines.push('');
    lines.push('### 最後の実行で成功したジョブの指摘');
    lines.push('');
    lines.push(`最終スナップショットの成功ジョブから集約（${successFindings.length} 件）。`);
    lines.push('');
    for (const f of successFindings) {
      const severity = f.severity || '?';
      const aspect = f.aspect || '?';
      const findingPath = f.path || '?';
      const summary = f.summary || '(summaryなし)';
      lines.push('<details>');
      lines.push(`<summary><b>[${severity}] [${aspect}] ${findingPath}</b> — ${summary}</summary>`);
      lines.push('');
      if (f.line_anchor) lines.push(`行アンカー: \`${f.line_anchor}\``);
      if (f.severity_rationale) lines.push(`判定根拠: ${f.severity_rationale}`);
      if (Array.isArray(f.verified_references) && f.verified_references.length > 0) {
        lines.push(`参照: ${f.verified_references.join(', ')}`);
      }
      if (f.body) {
        lines.push('');
        lines.push(String(f.body));
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
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
 * run-review-jobs.js（manifest検証失敗時の通知、Issue #271）は、gh pr comment の投稿に
 * 失敗した場合に opts.reason='notify-failed' のセンチネルを書く。この場合だけ監督ループが
 * 不完全完了（exit 0）ではなく失敗（exit 1）として扱うため、reason を区別できる必要がある。
 *
 * @param {string} workspace
 * @param {number|string} pr
 * @param {{reason?: string, [k: string]: unknown}} [opts] センチネルに追記する任意フィールド。
 *   reason を省略すると 'incomplete-review'（通知済みの不完全完了）。
 */
function writeSentinel(workspace, pr, opts = {}) {
  const sentinelPath = reviewArtifactPath(path.join(workspace, '.gh-maestro'), pr, '.incomplete');
  try {
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, JSON.stringify({
      pr,
      reason: 'incomplete-review',
      completed_at: new Date().toISOString(),
      ...opts,
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
 * @param {string|null} [integratedPath] completeモードで、RMフェーズ2が統合（重複を畳んだ）した
 *   findingsドラフトのパス。指定時は機械集約（aggregateFindings）の代わりにドラフトのfindingsを
 *   最終成果物へ使う。エンベロープ（pr/repo/headRefOid）は results.manifest_ref から確定させる。
 *   完全性ゲート・スキーマ検証・atomic writeは常に決定的に行う（統合判断はモデル、検証・書出しは決定論的）。
 * @returns {Promise<{ok: boolean, summary: object}>}
 */
async function finalizeReview(resultsPath, mode, outputPath, workspace, integratedPath = null) {
  // 1. results読み込み
  let results;
  try {
    results = readJsonFile(resultsPath);
  } catch (e) {
    const kind = e && e.kind === 'parse' ? 'JSON parse' : 'read';
    return { ok: false, summary: { error: `results ${kind} failed: ${e.message}` } };
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

    // 3. findings決定: RMフェーズ2が統合（重複を畳んだ）ドラフトが指定された場合はそれを使い、
    //    指定がなければ全成功ジョブのfindingsを機械集約する。エンベロープは results 由来で確定。
    let findings;
    if (integratedPath) {
      let draft;
      try {
        draft = readJsonFile(integratedPath);
      } catch (e) {
        const kind = e && e.kind === 'parse' ? 'JSON parse' : 'read';
        return { ok: false, summary: { error: `integrated draft ${kind} failed: ${e.message}` } };
      }
      if (!draft || typeof draft !== 'object' || !Array.isArray(draft.findings)) {
        return { ok: false, summary: { error: 'integrated draft must be an object with a findings array' } };
      }
      findings = draft.findings;
    } else {
      findings = aggregateFindings(results).findings;
    }
    const payload = {
      pr: results.manifest_ref.pr,
      repo: results.manifest_ref.repo,
      headRefOid: results.manifest_ref.headRefOid,
      findings,
    };

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

    const ghArgs = ['pr', 'comment', String(pr), '--repo', repo, '--body', commentBody];
    let ghResult;
    if (_ghForTest) {
      ghResult = _ghForTest(ghArgs);
    } else if (process.env.NODE_TEST_CONTEXT) {
      ghResult = { status: 1, stdout: '', stderr: 'テスト実行中（NODE_TEST_CONTEXT）のため、実際のGitHub投稿は行いません' };
    } else {
      try {
        ghResult = spawnSync('gh', ghArgs, { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        ghResult = { status: 1, stdout: '', stderr: e.message };
      }
    }

    if (ghResult && ghResult.status === 0) {
      commentUrl = (ghResult.stdout || '').trim();
    } else {
      commentError = (ghResult && (ghResult.stderr || '')) ? String(ghResult.stderr).trim() : '(gh 投稿失敗)';
    }

    // 4. センチネルファイル作成。
    // 投稿失敗時は「通知済みの不完全完了」を示す incomplete-review を書かず、notify-failed
    // センチネルを書く（PR #272 の notifyManifestProblem と同じ考え方。投稿に失敗したのに
    // 成功扱いすると、上限到達などの事実が orchestrator へ届かないまま黙って済む）。
    // 監督側 incompleteSentinelOutcome が notify-failed を exit 1 の失敗として扱う。
    if (!commentUrl && commentError) {
      const sentinelPath = writeSentinel(workspace, pr, {
        reason: 'notify-failed',
        postError: commentError,
        failureLabel: '不完全レビュー通知',
        failureDetail: commentError,
      });
      return {
        ok: false,
        summary: {
          error: `plane comment post failed: ${commentError}`,
          sentinelPath,
        },
      };
    }

    const sentinelPath = writeSentinel(workspace, pr);

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
  _setGhForTest,
};

// ── CLIエントリポイント ────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    let values, rest;
    try {
      ({ values, rest } = parseFlags(args, {
        flags: { '--results': {}, '--mode': {}, '--output': {}, '--workspace': {}, '--integrated': {} },
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
      for (const e of err.errors) console.error(`finalize-review: ${e.message}`);
      console.error(USAGE);
      process.exit(1);
    }

    if (values['--help'] || values['-h']) {
      console.log(USAGE);
      process.exit(0);
    }

    const resultsPath = values['--results'];
    const mode = values['--mode'];
    const outputPath = values['--output'];
    const workspace = values['--workspace'] || process.cwd();
    const integratedPath = values['--integrated'] || null;

    if (!resultsPath || !mode || (mode === 'complete' && !outputPath)) {
      console.error(USAGE);
      process.exit(1);
    }

    if (mode !== 'complete' && mode !== 'incomplete') {
      console.error('--mode must be "complete" or "incomplete"');
      process.exit(1);
    }

    const result = await finalizeReview(resultsPath, mode, outputPath || null, workspace, integratedPath);

    if (!result.ok) {
      console.error(JSON.stringify(result.summary));
      process.exit(1);
    }

    console.log(JSON.stringify(result.summary));
    process.exit(0);
  })();
}
