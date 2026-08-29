#!/usr/bin/env node
// declare-test-result.js — PR に対するテスト実行結果（事実）を申告・更新するスクリプト
//
// fail/pass はコマンドラインから受け取らず、同じ worktree で test runner が runtime root
// に生成した成果物だけから取得する。対象コミットも手入力せず、実行時のHEADを使う。
// 成果物が無い・壊れている場合は unknown の申告へ縮退し、push/PR/申告そのものは止めない。
//
// Usage:
//   node declare-test-result.js --pr <PR> [--repo <owner/repo>] [--workspace <path>]

'use strict';

const { spawnSync } = require('./shared/child-process');
const { resolveWorkspace, parseFlags } = require('./shared/workspace');
const { resolveGitHead } = require('./shared/git-head');
const { listComments, parseCommentsResponse } = require('./shared/gh-comments');
const {
  TEST_CONTENT_HASH_RE,
  calculateCommitContentHash,
  readTestResultArtifact,
} = require('./shared/test-result');
const {
  TEST_RESULT_MARKER,
  hasTestDeclarationMarker,
} = require('./shared/test-declaration');

const USAGE = `declare-test-result.js — PR に対するテスト実行結果（事実）を申告・更新する

Usage:
  node declare-test-result.js --pr <PR> [--repo <owner/repo>] [--workspace <path>]

Options:
  --pr <PR>             対象 PR 番号（必須、正の整数）
  --repo <owner/repo>   リポジトリ指定（省略可、workspaceからgh repo viewで特定）
  --workspace <path>    ワークスペースのルートパス（--repo省略時に使用）

動作:
  1. 同じ worktree の runtime root にあるテスト結果成果物を読み取る（値の手入力は不可）
  2. worktree の現在のHEADを対象コミットとして解決する
  3. 対象 PR の既存申告コメントを更新、または新規投稿する
  4. 成果物が欠落・破損している場合も unknown として申告する

Output (stdout):
  投稿または更新されたコメントの URL を1行出力
  exit 0 = 成功、exit 1 = 引数・HEAD・GitHubアクセス・コメント処理のエラー`;

const SPEC = {
  flags: {
    '--pr': { required: true },
    '--repo': {},
    '--workspace': {},
  },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

// ── gh / git 呼び出し（テストで注入可能） ────────────────────────────────────

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

function isKnownTestResult(testResult) {
  return testResult
    && testResult.provenance === 'test-runner'
    && (testResult.scope === 'full' || testResult.scope === 'partial')
    && Number.isSafeInteger(testResult.fail)
    && Number.isSafeInteger(testResult.pass)
    && typeof testResult.testedContentHash === 'string'
    && TEST_CONTENT_HASH_RE.test(testResult.testedContentHash);
}

function unknownTestResult(reason) {
  return {
    provenance: 'unknown',
    scope: 'unknown',
    reason: typeof reason === 'string' && reason ? reason : 'unavailable',
  };
}

// ── コメント本文生成 ────────────────────────────────────────────────────────

/**
 * 申告コメントの本文を組み立てる純粋関数。fail/pass は testResult からのみ参照する。
 * @param {{commit:string, testResult:object}} params
 * @returns {string}
 */
function buildCommentBody({ commit, testResult }) {
  const known = isKnownTestResult(testResult);
  const lines = [
    TEST_RESULT_MARKER,
    '### 🧪 テスト結果申告',
    `- **対象コミット**: \`${commit}\``,
  ];

  if (known) {
    const statusLabel = testResult.fail === 0 ? 'pass' : 'fail';
    lines.push(`- **結果**: ${statusLabel} (fail: ${testResult.fail}, pass: ${testResult.pass})`);
    if (Number.isSafeInteger(testResult.tests)) {
      lines.push(`- **実行件数**: \`${testResult.tests}\``);
    }
    lines.push(`- **実行元**: \`${testResult.provenance}\``);
    lines.push(`- **実行範囲**: \`${testResult.scope}\``);
  } else {
    lines.push('- **結果**: unknown');
    lines.push('- **実行元**: `unknown`');
    lines.push('- **実行範囲**: `unknown`');
    lines.push(`- **実行記録**: unavailable (${testResult && testResult.reason ? testResult.reason : 'unavailable'})`);
  }

  return lines.join('\n');
}

// ── コアロジック ──────────────────────────────────────────────────────────

/**
 * PR にテスト結果コメントがあれば更新、なければ新規投稿する。
 *
 * @param {{pr:string, repo?:string, workspace?:string, worktree?:string, headSha?:string}} params
 * @param {object} [deps] テスト用の依存注入
 * @param {function} [deps.ghRepoViewFn]
 * @param {function} [deps.ghListCommentsFn]
 * @param {function} [deps.ghCreateCommentFn]
 * @param {function} [deps.ghUpdateCommentFn]
 * @param {function} [deps.gitHeadFn]
 * @param {function} [deps.readTestResultFn]
 * @param {function} [deps.commitContentHashFn]
 * @returns {{ok:boolean, url?:string, error?:string, action?:'created'|'updated', provenance?:string, scope?:string}}
 */
function declareTestResult(params = {}, deps = {}) {
  const {
    pr,
    repo,
    workspace,
    worktree = process.cwd(),
    headSha,
  } = params;
  const {
    ghRepoViewFn = _ghRepoView,
    ghListCommentsFn = _ghListComments,
    ghCreateCommentFn = _ghCreateComment,
    ghUpdateCommentFn = _ghUpdateComment,
    gitHeadFn = resolveGitHead,
    readTestResultFn = readTestResultArtifact,
    commitContentHashFn = calculateCommitContentHash,
  } = deps;

  // API利用者が旧形式の数字やSHAを渡しても、それを申告へ流さない。CLIでは parseFlags
  // が未知フラグとして拒否するが、require経由の呼び出しにも同じ境界を置く。
  for (const obsolete of ['fail', 'pass', 'commit']) {
    if (Object.prototype.hasOwnProperty.call(params, obsolete)) {
      return { ok: false, error: `旧形式の ${obsolete} 指定は受け付けません。テスト成果物と現在のHEADを使用してください` };
    }
  }

  // 1. PR番号と対象HEADのバリデーション
  const prNum = parseInt(pr, 10);
  if (isNaN(prNum) || prNum <= 0 || String(prNum) !== String(pr).trim()) {
    return { ok: false, error: `--pr は正の整数で指定してください: ${pr}` };
  }

  const cwd = typeof worktree === 'string' && worktree.trim() ? worktree : process.cwd();
  let trimmedHead;
  if (headSha !== undefined && headSha !== null && String(headSha).trim()) {
    trimmedHead = String(headSha).trim();
    if (!/^[0-9a-fA-F]{7,40}$/.test(trimmedHead)) {
      return { ok: false, error: `対象HEADのSHAが不正です: ${headSha}` };
    }
  } else {
    try {
      trimmedHead = String(gitHeadFn(cwd) || '').trim();
    } catch (error) {
      return { ok: false, error: `対象コミットのHEAD解決に失敗しました: ${error.message}` };
    }
    if (!/^[0-9a-fA-F]{7,40}$/.test(trimmedHead)) {
      return { ok: false, error: `対象コミットのHEAD解決結果が不正です: ${trimmedHead || '(empty)'}` };
    }
  }

  // 成果物の失敗は外部操作の停止条件にしない。readTestResultArtifact は欠落・破損を
  // ok=falseで返し、ここでは unknown の本文へ変換する。
  let artifactRead;
  try {
    artifactRead = readTestResultFn(cwd);
  } catch {
    artifactRead = { ok: false, reason: 'unreadable' };
  }
  let testResult = unknownTestResult(artifactRead && artifactRead.reason);
  if (artifactRead && artifactRead.ok && isKnownTestResult(artifactRead.result)) {
    try {
      const commitContentHash = commitContentHashFn(cwd, trimmedHead);
      if (commitContentHash === artifactRead.result.testedContentHash) {
        testResult = artifactRead.result;
      } else {
        testResult = unknownTestResult('content-mismatch');
      }
    } catch {
      // コミット内容を検証できない場合も、申告自体は unknown として継続する。
      testResult = unknownTestResult('content-verification-unavailable');
    }
  } else if (artifactRead && artifactRead.ok) {
    testResult = unknownTestResult('invalid-artifact');
  }

  // 2. リポジトリ特定
  let targetRepo = typeof repo === 'string' ? repo.trim() : '';
  if (!targetRepo) {
    const ws = resolveWorkspace(workspace);
    if (!ws) {
      return { ok: false, error: 'ワークスペースを解決できません。--repoを指定するか、.gh-maestro/のあるディレクトリで実行してください。' };
    }
    const repoRes = ghRepoViewFn({ cwd: ws });
    if (!repoRes || repoRes.status !== 0) {
      return { ok: false, error: `リポジトリの特定に失敗しました: ${(repoRes && repoRes.stderr) || '(no stderr)'}` };
    }
    targetRepo = String(repoRes.stdout || '').trim();
  }
  if (!targetRepo) return { ok: false, error: 'リポジトリ名が空です' };

  // 3. コメント一覧取得
  const listRes = ghListCommentsFn(String(prNum), targetRepo);
  if (!listRes || listRes.status !== 0) {
    return { ok: false, error: `PR コメント一覧の取得に失敗しました: ${(listRes && listRes.stderr) || '(no stderr)'}` };
  }

  let comments;
  try {
    comments = parseCommentsResponse(listRes.stdout || '[]');
  } catch (error) {
    return { ok: false, error: `コメント一覧のJSONパースに失敗しました: ${error.message}` };
  }
  if (!comments) return { ok: false, error: 'コメント一覧のJSON形式が不正です' };

  const fullBody = buildCommentBody({ commit: trimmedHead, testResult });

  // 4. 既存の申告コメント検索（最新のコメントを対象にするため末尾から検索）
  const existingComment = [...comments].reverse()
    .find(comment => comment && hasTestDeclarationMarker(comment.body));

  if (existingComment) {
    const updateRes = ghUpdateCommentFn(existingComment.id, targetRepo, fullBody);
    if (!updateRes || updateRes.status !== 0) {
      return { ok: false, error: `申告コメントの更新に失敗しました: ${(updateRes && updateRes.stderr) || '(no stderr)'}` };
    }
    let url = existingComment.html_url;
    try {
      const parsed = JSON.parse(updateRes.stdout || '{}');
      if (parsed && parsed.html_url) url = parsed.html_url;
    } catch {
      // 更新成功後のURL応答だけが壊れている場合は、既存コメントのURLを返す。
    }
    return { ok: true, url, action: 'updated', provenance: testResult.provenance, scope: testResult.scope };
  }

  const createRes = ghCreateCommentFn(String(prNum), targetRepo, fullBody);
  if (!createRes || createRes.status !== 0) {
    return { ok: false, error: `申告コメントの投稿に失敗しました: ${(createRes && createRes.stderr) || '(no stderr)'}` };
  }
  let url;
  try {
    const parsed = JSON.parse(createRes.stdout || '{}');
    if (parsed && parsed.html_url) url = parsed.html_url;
  } catch {
    // 投稿成功後にURL JSONだけが壊れていても、投稿自体を失敗へ戻さない。
  }
  return { ok: true, url, action: 'created', provenance: testResult.provenance, scope: testResult.scope };
}

// ── CLI エントリポイント ──────────────────────────────────────────────────

function main(argv) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { exitCode: 0, stdout: USAGE };
    return { exitCode: 1, stderr: `declare-test-result: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) return { exitCode: 0, stdout: USAGE };

  const result = declareTestResult({
    pr: values['--pr'],
    repo: values['--repo'],
    workspace: values['--workspace'],
    worktree: process.cwd(),
  });
  if (!result.ok) return { exitCode: 1, stderr: `declare-test-result: ${result.error}` };
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
