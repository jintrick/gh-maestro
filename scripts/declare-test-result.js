#!/usr/bin/env node
// declare-test-result.js — PR に対するテスト実行結果（事実）を申告・更新するスクリプト
//
// コーダーが手元で実行したテスト結果（対象コミットSHA・pass数・fail数）を
// PR コメント（機械可読マーカー付き）として投稿または更新する。
//
// Usage:
//   node declare-test-result.js --pr <PR> --commit <sha> --fail <N> [--pass <N>] [--repo <owner/repo>] [--workspace <path>]
//
// workspace resolution order:
//   --workspace arg > GH_MAESTRO_WORKSPACE env > CWD upward search

'use strict';

const { spawnSync } = require('./child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { listComments } = require('./shared/gh-comments');

const TEST_RESULT_MARKER = '<!-- gh-maestro-test-result:v1 -->';

const USAGE = `declare-test-result.js — PR に対するテスト実行結果（事実）を申告・更新する

Usage:
  node declare-test-result.js --pr <PR> --commit <sha> --fail <N> [--pass <N>] [--repo <owner/repo>] [--workspace <path>]

Options:
  --pr <PR>             対象 PR 番号（必須、正の整数）
  --commit <sha>        テストを実行したコミットSHA（必須、7〜40文字の16進数）
  --fail <N>            失敗テスト数（必須、0以上の整数）
  --pass <N>            成功テスト数（任意、0以上の整数）
  --repo <owner/repo>   リポジトリ指定（省略可、git remoteから自動検出）
  --workspace <path>    ワークスペースのルートパス（省略時は環境変数またはCWDから上方探索で解決）

動作:
  1. 対象 PR の全コメントから、テスト結果マーカー（${TEST_RESULT_MARKER}）を持つコメントを検索
  2. 見つかればそのコメント本文を更新する（最新のテスト結果に上書き）
  3. 見つからなければ新規コメントを投稿する

Output (stdout):
  投稿または更新されたコメントの URL を1行出力
  exit 0 = 成功、exit 1 = エラー`;

const SPEC = {
  flags: {
    '--pr': { required: true },
    '--commit': { required: true },
    '--fail': { required: true },
    '--pass': {},
    '--repo': {},
    '--workspace': {},
  },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

// ── gh 呼び出し（テストで注入可能） ────────────────────────────────────────

let _ghRepoView = (opts = {}) => {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
    { encoding: 'utf8', ...opts });
};

let _ghListComments = (pr, repo, opts = {}) => {
  return listComments(repo, pr, opts);
};

let _ghCreateComment = (pr, repo, body, opts = {}) => {
  return spawnSync('gh', ['api', `repos/${repo}/issues/${pr}/comments`,
    '-f', `body=${body}`], { encoding: 'utf8', ...opts });
};

let _ghUpdateComment = (commentId, repo, body, opts = {}) => {
  return spawnSync('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${commentId}`,
    '-f', `body=${body}`], { encoding: 'utf8', ...opts });
};

// ── コメント本文生成 ────────────────────────────────────────────────────────

/**
 * 申告コメントの本文を組み立てる純粋関数。
 * @param {{ commit: string, failCount: number, passCount?: number }} params
 * @returns {string}
 */
function buildCommentBody({ commit, failCount, passCount }) {
  const isGreen = failCount === 0;
  const statusLabel = isGreen ? 'pass' : 'fail';
  const counts = [];
  counts.push(`fail: ${failCount}`);
  if (passCount !== undefined && passCount !== null) {
    counts.push(`pass: ${passCount}`);
  }
  const countsStr = counts.length > 0 ? ` (${counts.join(', ')})` : '';

  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${statusLabel}${countsStr}`;
}

// ── コアロジック ──────────────────────────────────────────────────────────

/**
 * PR にテスト結果コメントがあれば更新、なければ新規投稿する。
 *
 * @param {{ pr: string, commit: string, fail: number, pass?: number, repo?: string, workspace?: string }} params
 * @param {object} [deps]  テスト用の依存注入
 * @param {function} [deps.ghRepoViewFn]
 * @param {function} [deps.ghListCommentsFn]
 * @param {function} [deps.ghCreateCommentFn]
 * @param {function} [deps.ghUpdateCommentFn]
 * @returns {{ ok: boolean, url?: string, error?: string, action?: 'created'|'updated' }}
 */
function declareTestResult({ pr, commit, fail, pass, repo, workspace }, deps = {}) {
  const {
    ghRepoViewFn = _ghRepoView,
    ghListCommentsFn = _ghListComments,
    ghCreateCommentFn = _ghCreateComment,
    ghUpdateCommentFn = _ghUpdateComment,
  } = deps;

  // 1. バリデーション
  const prNum = parseInt(pr, 10);
  if (isNaN(prNum) || prNum <= 0 || String(prNum) !== String(pr).trim()) {
    return { ok: false, error: `--pr は正の整数で指定してください: ${pr}` };
  }

  const trimmedCommit = (commit || '').trim();
  if (!/^[0-9a-fA-F]{7,40}$/.test(trimmedCommit)) {
    return { ok: false, error: `--commit は7〜40文字のコミットSHA（16進数）で指定してください: ${commit}` };
  }

  const failCount = parseInt(fail, 10);
  if (isNaN(failCount) || failCount < 0 || String(failCount) !== String(fail).trim()) {
    return { ok: false, error: `--fail は0以上の整数で指定してください: ${fail}` };
  }

  let passCount = undefined;
  if (pass !== undefined && pass !== null && pass !== '') {
    passCount = parseInt(pass, 10);
    if (isNaN(passCount) || passCount < 0 || String(passCount) !== String(pass).trim()) {
      return { ok: false, error: `--pass は0以上の整数で指定してください: ${pass}` };
    }
  }

  // 2. リポジトリ特定
  let targetRepo = repo;
  if (!targetRepo) {
    const ws = resolveWorkspace(workspace);
    const repoRes = ghRepoViewFn(ws ? { cwd: ws } : {});
    if (repoRes.status !== 0) {
      return { ok: false, error: `リポジトリの特定に失敗しました: ${repoRes.stderr || '(no stderr)'}` };
    }
    targetRepo = (repoRes.stdout || '').trim();
  }
  if (!targetRepo) {
    return { ok: false, error: 'リポジトリ名が空です' };
  }

  // 3. コメント一覧取得
  const listRes = ghListCommentsFn(String(prNum), targetRepo);
  if (listRes.status !== 0) {
    return { ok: false, error: `PR コメント一覧の取得に失敗しました: ${listRes.stderr || '(no stderr)'}` };
  }

  let comments = [];
  try {
    const raw = JSON.parse(listRes.stdout || '[]');
    comments = Array.isArray(raw) ? (raw.length > 0 && Array.isArray(raw[0]) ? raw.flat() : raw) : [];
  } catch (e) {
    return { ok: false, error: `コメント一覧のJSONパースに失敗しました: ${e.message}` };
  }

  const fullBody = buildCommentBody({ commit: trimmedCommit, failCount, passCount });

  // 4. 既存の申告コメント検索（最新のコメントを対象にするため末尾から検索）
  const existingComment = Array.isArray(comments)
    ? [...comments].reverse().find(c => c && typeof c.body === 'string' && c.body.includes(TEST_RESULT_MARKER))
    : undefined;

  if (existingComment) {
    // PATCH 更新
    const updateRes = ghUpdateCommentFn(existingComment.id, targetRepo, fullBody);
    if (updateRes.status !== 0) {
      return { ok: false, error: `申告コメントの更新に失敗しました: ${updateRes.stderr || '(no stderr)'}` };
    }
    let url = existingComment.html_url;
    try {
      const parsed = JSON.parse(updateRes.stdout || '{}');
      if (parsed.html_url) url = parsed.html_url;
    } catch {}
    return { ok: true, url, action: 'updated' };
  } else {
    // 新規 POST
    const createRes = ghCreateCommentFn(String(prNum), targetRepo, fullBody);
    if (createRes.status !== 0) {
      return { ok: false, error: `申告コメントの投稿に失敗しました: ${createRes.stderr || '(no stderr)'}` };
    }
    let url;
    try {
      const parsed = JSON.parse(createRes.stdout || '{}');
      url = parsed.html_url;
    } catch {}
    return { ok: true, url, action: 'created' };
  }
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

function main(argv) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      return { exitCode: 0, stdout: USAGE };
    }
    return { exitCode: 1, stderr: `declare-test-result: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) {
    return { exitCode: 0, stdout: USAGE };
  }

  const pr = values['--pr'];
  const commit = values['--commit'];
  const fail = values['--fail'];
  const pass = values['--pass'];
  const repo = values['--repo'];
  const workspace = values['--workspace'];

  const result = declareTestResult({ pr, commit, fail, pass, repo, workspace });
  if (!result.ok) {
    return { exitCode: 1, stderr: `declare-test-result: ${result.error}` };
  }

  return { exitCode: 0, stdout: result.url || '' };
}

module.exports = {
  TEST_RESULT_MARKER,
  USAGE,
  SPEC,
  buildCommentBody,
  declareTestResult,
  main,
};

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
