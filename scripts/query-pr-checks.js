#!/usr/bin/env node
// query-pr-checks.js — PRの現在HEADに対するGitHub checksを照会する
'use strict';

const { parseFlags } = require('./shared/workspace');
const { resolveRepo } = require('./shared/repo');
const { queryPrChecks } = require('./shared/pr-checks');

const USAGE = `query-pr-checks.js — PRの現在HEADに対するGitHub checks / commit statusesを照会する

Usage:
  node query-pr-checks.js --pr <PR> [--repo <owner/repo>] [--workspace <path>]

Options:
  --pr <PR>             対象PR番号（必須、正の整数）
  --repo <owner/repo>   リポジトリ指定（省略時はworkspaceからgh repo viewで特定）
  --workspace <path>    ワークスペースのルートパス（--repo省略時に使用）

Output (stdout):
  成功時は対象HEADとチェック名・状態・詳細URLをJSON 1行で出力
  state: success / failure / running / other
  hasChecks=false はチェックなし、hasRunning=true は実行中、allCompleted=true は全チェック完了
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

function normalizePrNumber(pr) {
  const raw = pr === undefined || pr === null ? '' : String(pr).trim();
  const number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(number) || number <= 0 || String(number) !== raw) return null;
  return String(number);
}

function main(argv = process.argv.slice(2), deps = {}) {
  const parseFlagsFn = deps.parseFlagsFn || parseFlags;
  const resolveRepoFn = deps.resolveRepoFn || resolveRepo;
  const queryPrChecksFn = deps.queryPrChecksFn || queryPrChecks;
  let values;
  try {
    ({ values } = parseFlagsFn(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { exitCode: 0, stdout: USAGE };
    return { exitCode: 1, stderr: `query-pr-checks: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) return { exitCode: 0, stdout: USAGE };
  const pr = normalizePrNumber(values['--pr']);
  if (!pr) return { exitCode: 1, stderr: `query-pr-checks: --pr は正の整数で指定してください: ${values['--pr'] || ''}` };

  const repoResult = resolveRepoFn({ repo: values['--repo'], workspace: values['--workspace'] }, deps.repoDeps || {});
  if (!repoResult || repoResult.ok !== true) {
    return { exitCode: 1, stderr: `query-pr-checks: ${(repoResult && repoResult.error) || 'リポジトリを解決できません'}` };
  }
  const result = queryPrChecksFn({ pr, repo: repoResult.repo }, deps.checkDeps || {});
  if (!result || result.ok !== true) {
    return { exitCode: 1, stderr: `query-pr-checks: ${(result && result.error) || 'チェック結果を取得できません'}` };
  }

  return {
    exitCode: 0,
    stdout: JSON.stringify({
      pr: result.pr,
      headSha: result.headSha,
      checks: result.checks,
      hasChecks: result.hasChecks,
      hasRunning: result.hasRunning,
      allCompleted: result.allCompleted,
    }),
  };
}

module.exports = { USAGE, SPEC, normalizePrNumber, main };

if (require.main === module) {
  const result = main();
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
