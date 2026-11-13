'use strict';
// gh-comments.js — GitHub Issue/PR のコメント取得・投稿・更新を行う共通ヘルパー
//
// 背景:
// - プロジェクト内の複数スクリプトが、gh api --paginate --slurp でコメント一覧を
//   取得し平坦化する同一の処理を独立に実装していた（Issue #183）。
// - また、コメント本文を `-f body=${body}` としてコマンドライン引数で渡すと、Windows の
//   argv 長上限（約32KB）で ENAMETOOLONG になる（Issue #774）。本文は `-F body=@-` と
//   stdin（opts.input）経由で渡すことで上限を回避する。
//
// 各呼び出し元は、このモジュールの戻り値に基づいて独自のエラーハンドリング
// （GraphQLフォールバック・エラー時continue等）を実装する。本モジュールは
// REST API呼び出しと応答の平坦化のみを行い、ビジネスロジックは持ち込まない。

let _spawnSync = require('./child-process').spawnSync;

const GH_TIMEOUT_MS = 30000;

let _listComments = (repo, issue, opts = {}) => {
  const { since, per_page, ...restOpts } = opts;
  const args = ['api', '--method', 'GET', `repos/${repo}/issues/${issue}/comments`, '--paginate', '--slurp'];
  if (since) args.push('-f', `since=${since}`);
  if (per_page) args.push('-f', `per_page=${per_page}`);
  return _spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, ...restOpts });
};

/**
 * 本文を標準入力経由で渡して `gh` サブコマンドを実行する共通プリミティブ。
 * コマンドライン引数の長さ上限（Windows 約32KB）を避けるため、本文は必ず `input` に載せる。
 */
function runGhWithBody(args, body, opts = {}) {
  const { spawnSyncFn, ...restOpts } = opts;
  const spawnFn = spawnSyncFn || _spawnSync;
  return spawnFn('gh', args, {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    ...restOpts,
    // undefined だと spawnSync が stdin を継承し、@- / --body-file - 読み込みがハングしうるため必ず文字列化する。
    input: String(body ?? ''),
  });
}

/**
 * 本文を標準入力経由（`-F body=@-`）で送信する `gh api` の汎用呼び出しヘルパー。
 *
 * @param {string} endpoint - GitHub REST API エンドポイント
 * @param {string} body - stdin（`-F body=@-`）へ渡す本文
 * @param {string[]} [extraArgs=[]] - API フィールド等の追加引数
 * @param {object} [opts={}] - `method`（既定 `'POST'`）、`methodBeforeEndpoint`、`spawnSyncFn` 等のオプション
 */
function ghApiWithBody(endpoint, body, extraArgs = [], opts = {}) {
  const { method = 'POST', methodBeforeEndpoint = false, ...restOpts } = opts;
  const targetArgs = methodBeforeEndpoint ? ['-X', method, endpoint] : [endpoint, '-X', method];
  return runGhWithBody(['api', ...targetArgs, '-F', 'body=@-', ...extraArgs], body, restOpts);
}

/**
 * `gh pr comment <pr> --repo <repo> --body-file -` で PR へ通常コメントを投稿する共有ヘルパー。
 *
 * @param {string} repo - `owner/repo`
 * @param {number|string} pr - PR 番号
 * @param {string} body - コメント本文（stdin 経由）
 * @param {object} [opts={}] - `ghForTest`, `respectTestContextGuard`, `spawnSyncFn` 等
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }}
 */
function createPrComment(repo, pr, body, opts = {}) {
  const { ghForTest, respectTestContextGuard = false, ...restOpts } = opts;
  const ghArgs = ['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'];
  const ghOpts = { encoding: 'utf8', stdio: 'pipe', timeout: GH_TIMEOUT_MS, ...restOpts, input: String(body ?? '') };
  if (ghForTest) {
    return ghForTest(ghArgs, ghOpts);
  }
  if (respectTestContextGuard && process.env.NODE_TEST_CONTEXT) {
    return { status: 1, stdout: '', stderr: 'テスト実行中（NODE_TEST_CONTEXT）のため、実際のGitHub投稿は行いません' };
  }
  try {
    const r = runGhWithBody(ghArgs, body, { stdio: 'pipe', ...restOpts });
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || (r.error ? r.error.message : ''),
      error: r.error,
    };
  } catch (e) {
    return { status: 1, stdout: '', stderr: e.message, error: e };
  }
}

/**
 * `spawnSync` の戻り値から失敗理由を抽出する（`stderr` が空でも `error.message` を失わない）。
 */
function ghErrorDetail(result, { includeStdout = false, fallback = '(no stderr)' } = {}) {
  if (!result) return fallback;
  const candidates = [result.stderr, includeStdout ? result.stdout : '', result.error && result.error.message];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return fallback;
}

let _createComment = (repo, issue, body, opts = {}) => {
  return ghApiWithBody(`repos/${repo}/issues/${issue}/comments`, body, [], opts);
};

let _updateComment = (repo, commentId, body, opts = {}) => {
  return ghApiWithBody(`repos/${repo}/issues/comments/${commentId}`, body, [], {
    ...opts,
    method: 'PATCH',
    methodBeforeEndpoint: true,
  });
};

/**
 * `gh api --paginate --slurp` の出力（ページ配列の配列、例: `[[c1,c2],[c3]]`）を
 * 1段階フラット化してコメント配列を返す。要素が配列でないコメントオブジェクトの
 * フラットな配列（`--paginate` を使わない旧来の応答形状・テストのモック）が
 * 渡された場合はそのまま返す（後方互換）。全体が配列でない場合は null。
 *
 * @param {string} stdout
 * @returns {object[] | null}
 */
function parseCommentsResponse(stdout) {
  const parsed = JSON.parse(stdout || '[]');
  if (!Array.isArray(parsed)) return null;
  if (parsed.length > 0 && parsed.every((page) => Array.isArray(page))) {
    return parsed.flat();
  }
  return parsed;
}

module.exports = {
  GH_TIMEOUT_MS,
  listComments: (repo, issue, opts) => _listComments(repo, issue, opts || {}),
  createComment: (repo, issue, body, opts) => _createComment(repo, issue, body, opts || {}),
  updateComment: (repo, commentId, body, opts) => _updateComment(repo, commentId, body, opts || {}),
  ghApiWithBody,
  createPrComment,
  ghErrorDetail,
  parseCommentsResponse,
  _setListComments: (fn) => { _listComments = fn; },
  _setSpawnSync: (fn) => { _spawnSync = fn; },
};
