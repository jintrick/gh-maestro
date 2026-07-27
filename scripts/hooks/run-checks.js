#!/usr/bin/env node
'use strict';
// git hook（pre-commit/pre-push）から呼ばれる、言語エコシステム規約検出ベースの
// lint/format/typecheck/test ランナー。
//
// コマンドをプロジェクトごとに決め打ちせず、対象プロジェクトの package.json
// から規約（lint-staged 設定・test/typecheck スクリプトの有無）を検出して実行する。
// 今はNode/JS/TS（package.json ベース）のみ対応。他言語は必要になってから追加する。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('../child-process');
const { parseFlags, hasHelpFlag } = require('../shared/workspace');

const USAGE = `run-checks.js — 言語エコシステム規約を検出してlint/format/typecheck/testを実行する

Usage: node run-checks.js <precommit|prepush> [workspaceRoot]

Arguments:
  precommit|prepush  実行するステージ
                      precommit: ステージ済みファイルのみ対象のlint/format（lint-staged検出時のみ）
                      prepush:   プロジェクト全体のtest/typecheck
  [workspaceRoot]     対象プロジェクトのルート（デフォルト CWD）

Output:
  検出できたチェックを実行し、失敗があれば終了コード1で終わる。
  既知のエコシステムが検出できない場合は何もせず終了コード0で終わる（fail-open）。`;

const LINT_STAGED_CONFIG_FILES = [
  '.lintstagedrc',
  '.lintstagedrc.json',
  '.lintstagedrc.js',
  '.lintstagedrc.cjs',
  '.lintstagedrc.mjs',
  '.lintstagedrc.yaml',
  '.lintstagedrc.yml',
  'lint-staged.config.js',
  'lint-staged.config.cjs',
  'lint-staged.config.mjs',
];

/**
 * package.json を読み込む。存在しない/パース失敗時は null（fail-open）。
 * @param {string} workspaceRoot
 * @returns {{pkg: object}|null}
 */
function readPackageJson(workspaceRoot) {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return { pkg };
  } catch {
    return null;
  }
}

/**
 * precommitステージで何を実行すべきかを検出する（純粋関数、副作用なし）。
 * @param {string} workspaceRoot
 * @returns {{cmd: string, args: string[]}|null} 実行すべきコマンド、無ければnull
 */
function detectPrecommitPlan(workspaceRoot) {
  const loaded = readPackageJson(workspaceRoot);
  if (!loaded) return null;

  const hasLintStagedKey = Object.prototype.hasOwnProperty.call(loaded.pkg, 'lint-staged');
  const hasLintStagedConfigFile = LINT_STAGED_CONFIG_FILES.some(f => fs.existsSync(path.join(workspaceRoot, f)));

  if (!hasLintStagedKey && !hasLintStagedConfigFile) return null;

  return { cmd: 'npx', args: ['--no-install', 'lint-staged'] };
}

/**
 * prepushステージで何を実行すべきかを検出する（純粋関数、副作用なし）。
 * @param {string} workspaceRoot
 * @returns {{cmd: string, args: string[], label: string}[]} 実行すべきコマンドの配列（空もあり得る）
 */
function detectPrepushPlan(workspaceRoot) {
  const loaded = readPackageJson(workspaceRoot);
  if (!loaded) return [];

  const scripts = loaded.pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return [];

  const plan = [];
  if (typeof scripts.test === 'string') {
    plan.push({ cmd: 'npm', args: ['test'], label: 'test' });
  }
  const typecheckKey = typeof scripts.typecheck === 'string' ? 'typecheck'
    : typeof scripts['type-check'] === 'string' ? 'type-check'
    : null;
  if (typecheckKey) {
    plan.push({ cmd: 'npm', args: ['run', typecheckKey], label: typecheckKey });
  }
  return plan;
}

/**
 * @param {'precommit'|'prepush'} stage
 * @param {string} workspaceRoot
 * @param {(msg: string) => void} log
 * @returns {{status: number}}
 */
function main(stage, workspaceRoot, log) {
  if (stage === 'precommit') {
    const plan = detectPrecommitPlan(workspaceRoot);
    if (!plan) {
      log('[run-checks] lint-staged未設定のためpre-commit側のlint/formatはスキップします（プロジェクトにlint-stagedを導入すると有効になります）');
      return { status: 0 };
    }
    log(`[run-checks] 実行: ${plan.cmd} ${plan.args.join(' ')}`);
    const r = spawnSync(plan.cmd, plan.args, { cwd: workspaceRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    return { status: r.status ?? 1 };
  }

  if (stage === 'prepush') {
    const plan = detectPrepushPlan(workspaceRoot);
    if (plan.length === 0) {
      log('[run-checks] test/typecheckスクリプトが見つからないためpre-push側のチェックはスキップします');
      return { status: 0 };
    }
    let failed = false;
    for (const step of plan) {
      log(`[run-checks] 実行: ${step.cmd} ${step.args.join(' ')} (${step.label})`);
      const r = spawnSync(step.cmd, step.args, { cwd: workspaceRoot, stdio: 'inherit', shell: process.platform === 'win32' });
      if ((r.status ?? 1) !== 0) {
        failed = true;
        log(`[run-checks] ${step.label} が失敗しました`);
      }
    }
    return { status: failed ? 1 : 0 };
  }

  log(USAGE);
  return { status: 1 };
}

module.exports = { detectPrecommitPlan, detectPrepushPlan, main, USAGE };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { rest, exitFlagMiss } = parseFlags(argv, []);

  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  if (rest.length < 1 || rest.length > 2) {
    console.error(USAGE);
    process.exit(1);
  }

  const [stage, workspaceRootArg] = rest;
  if (stage !== 'precommit' && stage !== 'prepush') {
    console.error(USAGE);
    process.exit(1);
  }

  const workspaceRoot = workspaceRootArg ? path.resolve(workspaceRootArg) : process.cwd();
  const result = main(stage, workspaceRoot, (msg) => console.log(msg));
  process.exit(result.status);
}
