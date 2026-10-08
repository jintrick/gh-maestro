#!/usr/bin/env node
// query-test-status.js — PRの現在のテスト申告状態（事実）を照会する
//
// Usage:
//   node query-test-status.js --pr <PR> [--repo <owner/repo>] [--workspace <path>]

'use strict';

const { spawnSync } = require('./shared/child-process');
const { parseFlags } = require('./shared/workspace');
const { resolveRepo } = require('./shared/repo');
const { parsePrViewResponse } = require('./shared/pr-view');
const {
  evaluateTestDeclaration,
  findLatestTrustedTestDeclaration,
} = require('./shared/test-declaration');

const GH_TIMEOUT_MS = 30000;

const USAGE = `query-test-status.js — PRの現在のテスト申告状態（事実）を照会する

Usage:
  node query-test-status.js --pr <PR> [--repo <owner/repo>] [--workspace <path>]

Options:
  --pr <PR>             対象PR番号（必須、正の整数）
  --repo <owner/repo>   リポジトリ指定（省略時はworkspaceからgh repo viewで特定）
  --workspace <path>    ワークスペースのルートパス（--repo省略時に使用）

Output (stdout):
  成功時、テスト申告状態と照合に使った事実をJSON 1行で出力
  status: GREEN / RED / STALE / NONE
  provenance: test-runner / unknown / none
  scope: full / partial / aggregate / unknown / none
  lint: complete/pass, complete/findings (with findingCount), unavailable, or missing
  typecheck: complete/pass, complete/fail (with exitCode), unavailable, undefined, or missing
  aggregate scope includes layers (with failedTests and otherFailedCount on failures), allLayersPresent, and allLayersComplete
  exit 0 = 成功、exit 1 = 引数・GitHubアクセス・応答解釈のエラー`;

const SPEC = {
  flags: {
    '--pr': { required: true },
    '--repo': {},
    '--workspace': {},
  },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

function buildPrViewArgs(pr, repo) {
  return [
    'pr', 'view', pr,
    '--repo', repo,
    '--json', 'comments,headRefOid,author',
  ];
}

let _ghPrView = (pr, repo, opts = {}) => {
  return spawnSync('gh', buildPrViewArgs(pr, repo), {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    ...opts,
  });
};

function normalizePrNumber(pr) {
  const raw = pr === undefined || pr === null ? '' : String(pr).trim();
  const number = parseInt(raw, 10);
  if (!/^\d+$/.test(raw) || !Number.isFinite(number) || number <= 0 || String(number) !== raw) {
    return null;
  }
  return String(number);
}

/**
 * GitHubからPRコメントとHEADを読み、共有された申告ルールで評価する。
 *
 * @param {{ pr: string|number, repo?: string, workspace?: string }} params
 * @param {object} [deps] テスト用の依存注入
 * @param {function} [deps.ghRepoViewFn]
 * @param {function} [deps.ghPrViewFn]
 * @returns {{ ok: true, status: string, declaredSha?: string, headSha?: string, fail?: number, pass?: number, provenance:string, scope:string, lint: object, layers?: object, allLayersPresent?: boolean, allLayersComplete?: boolean } | { ok: false, error: string }}
 */
function queryTestStatus({ pr, repo, workspace }, deps = {}) {
  const {
    ghRepoViewFn,
    ghPrViewFn = _ghPrView,
  } = deps;

  const prNumber = normalizePrNumber(pr);
  if (!prNumber) {
    return { ok: false, error: `--pr は正の整数で指定してください: ${pr}` };
  }

  const repoResult = resolveRepo({ repo, workspace }, { ghRepoViewFn });
  if (!repoResult.ok) return repoResult;
  const { repo: targetRepo, workspacePath } = repoResult;

  const prRes = ghPrViewFn(prNumber, targetRepo, workspacePath ? { cwd: workspacePath } : {});
  if (!prRes || prRes.status !== 0) {
    return {
      ok: false,
      error: `PR #${prNumber} の情報取得に失敗しました: ${(prRes && prRes.stderr) || '(no stderr)'}`,
    };
  }

  const parsed = parsePrViewResponse(prRes.stdout);
  if (!parsed.ok) return parsed;

  const declaration = findLatestTrustedTestDeclaration(parsed.comments, parsed.prAuthor);
  const evaluation = evaluateTestDeclaration(declaration, parsed.headSha);
  return { ok: true, ...evaluation };
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

function main(argv, deps = {}) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      return { exitCode: 0, stdout: USAGE };
    }
    return { exitCode: 1, stderr: `query-test-status: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) {
    return { exitCode: 0, stdout: USAGE };
  }

  const result = queryTestStatus({
    pr: values['--pr'],
    repo: values['--repo'],
    workspace: values['--workspace'],
  }, deps);
  if (!result.ok) {
    return { exitCode: 1, stderr: `query-test-status: ${result.error}` };
  }

  return { exitCode: 0, stdout: JSON.stringify({
    status: result.status,
    provenance: result.provenance,
    scope: result.scope,
    lint: result.lint,
    typecheck: result.typecheck || { status: 'missing', reason: 'typecheck-result-missing' },
    ...(result.declaredSha !== undefined ? { declaredSha: result.declaredSha } : {}),
    ...(result.headSha !== undefined ? { headSha: result.headSha } : {}),
    ...(result.fail !== undefined ? { fail: result.fail } : {}),
    ...(result.pass !== undefined ? { pass: result.pass } : {}),
    ...(result.layers !== undefined ? { layers: result.layers } : {}),
    ...(result.allLayersPresent !== undefined ? { allLayersPresent: result.allLayersPresent } : {}),
    ...(result.allLayersComplete !== undefined ? { allLayersComplete: result.allLayersComplete } : {}),
  }) };
}

module.exports = {
  GH_TIMEOUT_MS,
  USAGE,
  SPEC,
  buildPrViewArgs,
  normalizePrNumber,
  parsePrViewResponse,
  queryTestStatus,
  main,
};

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
