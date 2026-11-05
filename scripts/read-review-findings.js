#!/usr/bin/env node
'use strict';
// read-review-findings.js
// Review Manager の指摘全文を、手元に残るレビュー結果JSON（records/pr/<PR>/review/manager.json）から読む。
// 通知本文（PR_REVIEW / REVIEW_COMMENT）は切り詰められうるため、orchestrator はトリアージ前に
// 必ずこのコマンドで全文を読む（ADR 0059）。GitHub API からは読まない。
//
// 終了コード:
//   0: 読めた（指摘0件も0）
//   1: 引数エラー・workspace 解決不能
//   2: manager.json が無い（レビュー結果が存在しない）
//   3: manager.json が壊れている（読み取り失敗・JSON構文エラー・形式不正・PR番号の不一致）

const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { reviewArtifactPath } = require('./shared/review-manager-paths');
const { readReviewManagerGeneration } = require('./shared/review-manager-generation');
const { readJsonFile } = require('./shared/json-file');
const {
  validatePayload,
  validateFinding,
  formatFindingHeading,
} = require('./review-publisher');

const USAGE = `read-review-findings.js — Review Manager の指摘全文を manager.json から読む

Usage: node read-review-findings.js --pr <N> [--workspace <path>] [--json]

Options:
  --pr <N>             対象 PR 番号（正の整数、必須）
  --workspace <path>   ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または CWD から上方探索で解決）
  --json               検証済みの結果を JSON で出力する（前回の指摘ファイルの作成に使う）
  --help, -h           このヘルプを表示する

読むファイル: <workspace>/.gh-maestro/records/pr/<PR>/review/manager.json
通知本文は読まない。指摘全文はこのコマンドの出力を正本として扱う。

Exit codes:
  0  読めた（指摘0件を含む）
  1  引数エラー・workspace 解決不能
  2  manager.json が無い（「指摘なし」ではない。レビュー結果が存在しない）
  3  manager.json が壊れている（読み取り失敗・JSON構文エラー・形式不正・PR不一致）

Output (stdout):
  既定: 見出し（PR・repo・headRefOid・世代状態・件数）と、指摘ごとの全項目
  --json: { pr, repo, headRefOid, findings[] }`;

class ReviewFindingsError extends Error {
  /**
   * @param {2|3} exitCode
   * @param {string} message
   */
  constructor(exitCode, message) {
    super(message);
    this.name = 'ReviewFindingsError';
    this.exitCode = exitCode;
  }
}

/**
 * manager.json を読み、形式と PR 番号を検証して返す。
 * 無い場合は exit 2、壊れている場合は exit 3 の ReviewFindingsError を投げる（フェイルクローズ）。
 * 「指摘なし」と「読めない」を同じ値に縮退させない。
 * @param {string} workspace
 * @param {string|number} pr 検証済みのPR番号
 * @returns {{payload: object, artifactPath: string}}
 */
function loadReviewFindings(workspace, pr) {
  const artifactPath = reviewArtifactPath(workspace, pr, '.json');
  let payload;
  try {
    payload = readJsonFile(artifactPath);
  } catch (error) {
    if (error.kind === 'read' && error.code === 'ENOENT') {
      throw new ReviewFindingsError(2, `manager.json がありません: ${artifactPath}`);
    }
    if (error.kind === 'read') {
      throw new ReviewFindingsError(3, `manager.json を読めません: ${artifactPath}: ${error.message}`);
    }
    throw new ReviewFindingsError(3, `manager.json の JSON 構文が壊れています: ${artifactPath}: ${error.message}`);
  }

  const problems = [];
  const payloadCheck = validatePayload(payload);
  if (!payloadCheck.ok) problems.push(...payloadCheck.errors);
  if (payload && typeof payload === 'object' && String(payload.pr) !== String(pr)) {
    problems.push(`pr が要求された PR #${pr} と一致しません（記録: ${JSON.stringify(payload.pr)}）`);
  }
  if (payload && Array.isArray(payload.findings)) {
    payload.findings.forEach((finding, index) => {
      for (const error of validateFinding(finding)) {
        problems.push(`findings[${index}]: ${error}`);
      }
    });
  }
  if (problems.length > 0) {
    throw new ReviewFindingsError(3, `manager.json の形式が不正です: ${artifactPath}\n  - ${problems.join('\n  - ')}`);
  }
  return { payload, artifactPath };
}

/**
 * 世代記録（manager.generation.json）の状態を読む。読めない場合は理由を返すだけで失敗にはしない
 * （指摘の全文表示そのものは manager.json の検証で決まる）。
 * @param {string} workspace
 * @param {string|number} pr
 * @returns {string}
 */
function describeGeneration(workspace, pr) {
  try {
    const generation = readReviewManagerGeneration(workspace, pr);
    if (!generation) return '世代記録なし（この manager.json が最新の周回の結果か確認できません）';
    if (generation.state === 'complete') return 'complete（最新の周回の結果）';
    return `${generation.state}（この manager.json は最新の周回の結果ではない可能性があります）`;
  } catch (error) {
    return `世代記録を読めません（${error.message}）`;
  }
}

/**
 * 指摘1件を、通し番号付きの全項目テキストに整形する。省略せず全文を出す。
 * @param {object} finding
 * @param {number} number 1始まりの通し番号
 * @returns {string}
 */
function formatFindingFull(finding, number) {
  const lines = [
    `### ${number}. ${formatFindingHeading(finding)}`,
    `- 観点: ${finding.aspect}`,
    `- 対象: ${finding.path}`,
    `- 行アンカー: ${finding.line_anchor}`,
  ];
  if (finding.context_before) lines.push(`- 直前の行: ${finding.context_before}`);
  if (finding.context_after) lines.push(`- 直後の行: ${finding.context_after}`);
  lines.push(`- 重要度: ${finding.severity}`);
  lines.push(`- 判定根拠: ${finding.severity_rationale}`);
  lines.push(`- 検証した参照: ${finding.verified_references.join(', ')}`);
  lines.push('', finding.body);
  return lines.join('\n');
}

/**
 * 既定の出力（テキスト）を組み立てる。
 * @param {object} payload 検証済みの manager.json
 * @param {string} generationState
 * @returns {string}
 */
function formatText(payload, generationState) {
  const head = [
    `## PR #${payload.pr} — Review Manager 指摘全文`,
    `- repo: ${payload.repo}`,
    `- headRefOid: ${payload.headRefOid}`,
    `- 世代: ${generationState}`,
    `- 指摘件数: ${payload.findings.length}`,
  ];
  if (payload.findings.length === 0) {
    return `${head.join('\n')}\n\n指摘なし（0件）。`;
  }
  const blocks = payload.findings.map((finding, index) => formatFindingFull(finding, index + 1));
  return `${head.join('\n')}\n\n${blocks.join('\n\n')}`;
}

/**
 * 引数を解析して結果を返す（テストから直接呼べるよう、副作用は持たない）。
 * @param {string[]} argv
 * @returns {{mode: 'help'} | {mode: 'run', pr: string, workspaceArg: string|undefined, json: boolean}}
 */
function parseArgs(argv) {
  let values;
  try {
    ({ values } = parseFlags(argv, {
      flags: { '--pr': { required: true }, '--workspace': {} },
      booleans: ['--json', '--help', '-h'],
      positionals: { min: 0, max: 0 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { mode: 'help' };
    const detail = err.errors.map((e) => e.message).join('; ');
    throw new ReviewFindingsError(1, `引数エラー: ${detail}`);
  }
  if (values['--help'] || values['-h']) return { mode: 'help' };
  return {
    mode: 'run',
    pr: values['--pr'],
    workspaceArg: values['--workspace'],
    json: Boolean(values['--json']),
  };
}

module.exports = {
  ReviewFindingsError,
  loadReviewFindings,
  describeGeneration,
  formatFindingFull,
  formatText,
  parseArgs,
};

if (require.main === module) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`read-review-findings: ${error.message}`);
    console.error(USAGE);
    process.exit(error.exitCode || 1);
  }
  if (parsed.mode === 'help') {
    console.log(USAGE);
    process.exit(0);
  }
  if (!/^[1-9][0-9]*$/.test(parsed.pr)) {
    console.error('read-review-findings: --pr は正の整数である必要があります');
    process.exit(1);
  }
  const workspace = resolveWorkspace(parsed.workspaceArg);
  if (!workspace) {
    console.error('read-review-findings: ワークスペースを解決できません。--workspace を指定するか、GH_MAESTRO_WORKSPACE または .gh-maestro/ のあるディレクトリで実行してください');
    process.exit(1);
  }

  try {
    const { payload, artifactPath } = loadReviewFindings(workspace, parsed.pr);
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify({
        pr: payload.pr,
        repo: payload.repo,
        headRefOid: payload.headRefOid,
        findings: payload.findings,
      }, null, 2)}\n`);
    } else {
      console.log(formatText(payload, describeGeneration(workspace, parsed.pr)));
    }
    process.exit(0);
  } catch (error) {
    if (error instanceof ReviewFindingsError) {
      console.error(`read-review-findings: ${error.message}`);
      process.exit(error.exitCode);
    }
    console.error(`read-review-findings: 予期しないエラー: ${error.message}`);
    process.exit(3);
  }
}
