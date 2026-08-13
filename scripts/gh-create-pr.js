'use strict';
// gh-create-pr.js
// gh pr create のラッパー。baseブランチを環境変数 GH_MAESTRO_BASE_BRANCH から解決する
// （ワーカー起動時に spawn-worker.js / inbox-supervisor.js が注入）。
// git upstream tracking には依存しない。upstream はコーダーの標準的な `git push -u` で
// 自ブランチへ書き換わるため、これに依存すると base==head でPR作成が壊れる（Issue #269）。
// コーダーが --base を明示的に指定できず、誤ったbaseブランチでPRが作成されるのを防止する。
//
// Usage:
//   node gh-create-pr.js --title <title> --body <body> [--repo <owner/repo>]
//   node gh-create-pr.js --title <title> --body-file <path> [--repo <owner/repo>]
//
// 標準出力: PR のURL（1行）
// 終了コード: 0=成功、1=エラー

const { spawnSync } = require('./child-process');
const { parseFlags } = require('./shared/workspace');

const USAGE = `Usage:
  node gh-create-pr.js --title <title> --body <body> [--repo <owner/repo>]
  node gh-create-pr.js --title <title> --body-file <path> [--repo <owner/repo>]

Arguments:
  --title <title>           PRのタイトル（必須）
  --body <body>             PRの本文（--body-file と排他、いずれか必須）
  --body-file <path>        PR本文のファイルパス（--body と排他、いずれか必須）
  --repo <owner/repo>       リポジトリ指定（省略可、git remoteから自動検出）

baseブランチは環境変数 GH_MAESTRO_BASE_BRANCH から解決されます（ワーカー起動時に
spawn-worker.js / inbox-supervisor.js が注入。未設定なら明確に失敗します）。
--base フラグは受け付けません。

Output:
  PRのURLを標準出力に出力します。
  exit 0 = 成功、exit 1 = エラー`;

const SPEC = {
  flags: { '--title': {}, '--body': {}, '--body-file': {}, '--repo': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

/**
 * baseブランチを環境変数 GH_MAESTRO_BASE_BRANCH から解決する。
 *
 * git upstream tracking には依存しない。upstream はコーダーの標準的な `git push -u` で
 * 自ブランチへ書き換わるため、これに依存すると base==head となりPR作成が壊れる
 * （Issue #269）。base はワーカー起動時に注入されるため、コーダーが --base で
 * 上書きすることはできない（フェイルクローズ: 未設定なら誤ったbaseでPRを作らず失敗する）。
 *
 * @param {object} [opts]
 * @param {object} [opts.env] - 環境変数（省略時は process.env）。テスト用。
 * @returns {string} baseブランチ名（例: "dev"）。
 * @throws {Error} GH_MAESTRO_BASE_BRANCH 未設定・不正時
 */
function resolveBaseBranch(opts = {}) {
  const env = opts.env || process.env;
  const baseBranch = (env.GH_MAESTRO_BASE_BRANCH || '').trim();
  if (!baseBranch) {
    throw new Error('GH_MAESTRO_BASE_BRANCH が設定されていません。ワーカー起動時にベースブランチが渡されているか確認してください。');
  }
  if (baseBranch.startsWith('-')) {
    throw new Error(`不正なベースブランチ形式です: ${baseBranch}（- 始まりの値は受け付けません）`);
  }
  return baseBranch;
}

/**
 * gh pr create の引数配列を組み立てる（純関数。Issue #275 項目2）。
 *
 * 元は createPr の NODE_TEST_CONTEXT ガードの内側に引数組み立てが埋まっており、テストが
 * withGuardBypassed でガードを迂回しないと検証できなかった。実PR作成（外部副作用）と
 * は独立に検証できるよう切り出し、テストはこの関数を直接呼ぶ。
 *
 * @param {object} opts  createPr と同じ opts（title/body/bodyFile/repo/cwd/env）
 * @returns {string[]}  gh pr create の引数配列
 */
function buildPrCreateArgs(opts) {
  const baseBranch = resolveBaseBranch(opts);
  const args = ['pr', 'create', '--base', baseBranch, '--title', opts.title];
  if (opts.body) {
    args.push('--body', opts.body);
  } else if (opts.bodyFile) {
    args.push('--body-file', opts.bodyFile);
  }
  if (opts.repo) args.push('--repo', opts.repo);
  return args;
}

/**
 * gh pr create を実行する。
 * @param {object} opts
 * @param {string} opts.title - PRタイトル
 * @param {string} [opts.body] - PR本文（body-file と排他）
 * @param {string} [opts.bodyFile] - PR本文のファイルパス（body と排他）
 * @param {string} [opts.repo] - リポジトリ指定
 * @param {string} [opts.cwd] - 実行ディレクトリ
 * @param {object} [opts.env] - 環境変数（省略時は process.env）。resolveBaseBranch へ渡す。
 * @returns {{ url: string, status: number, stderr: string }}
 */
function createPr(opts) {
  // NODE_TEST_CONTEXT 検出時に実PR作成を機械的に拒否する（Issue #202 の構造的対策）。
  // ワーカーenv（GH_MAESTRO_BASE_BRANCH 等）がテスト配下の子プロセスへ漏れた場合でも、
  // 実リポジトリへ誤ってPRが作られるのを防ぐ（msg-send.js の投稿拒否と同じ方式）。
  if (process.env.NODE_TEST_CONTEXT) {
    return { url: '', status: 1, stderr: 'テスト実行中（NODE_TEST_CONTEXT）のため、実際のPR作成は行いません' };
  }
  const args = buildPrCreateArgs(opts);
  const r = spawnSync('gh', args, { cwd: opts.cwd, encoding: 'utf8' });
  return { url: (r.stdout || '').trim(), status: r.status, stderr: (r.stderr || '').trim() };
}

// ── CLI エントリポイント ─────────────────────────────────────────────────────

function main(argv) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      return { exitCode: 0, stdout: USAGE };
    }
    return { exitCode: 1, stderr: `gh-create-pr: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) {
    return { exitCode: 0, stdout: USAGE };
  }

  const title = values['--title'];
  const body = values['--body'];
  const bodyFile = values['--body-file'];
  const repo = values['--repo'];

  if (!title) {
    return { exitCode: 1, stderr: `gh-create-pr: --title が必要です\n${USAGE}` };
  }
  if (!body && !bodyFile) {
    return { exitCode: 1, stderr: `gh-create-pr: --body または --body-file が必要です\n${USAGE}` };
  }
  if (body && bodyFile) {
    return { exitCode: 1, stderr: `gh-create-pr: --body と --body-file は同時に指定できません\n${USAGE}` };
  }

  let result;
  try {
    result = createPr({ title, body, bodyFile, repo });
  } catch (e) {
    return { exitCode: 1, stderr: `gh-create-pr: エラー: ${e.message}` };
  }

  if (result.status !== 0) {
    return { exitCode: 1, stderr: `gh-create-pr: gh pr create 失敗:\n${result.stderr || '(no stderr)'}` };
  }

  return { exitCode: 0, stdout: result.url };
}

module.exports = { resolveBaseBranch, buildPrCreateArgs, createPr, main, USAGE };

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
