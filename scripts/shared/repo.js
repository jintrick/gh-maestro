'use strict';
// repo.js — workspaceからGitHub owner/repoを解決する共通処理

const { spawnSync } = require('./child-process');
const { resolveWorkspace } = require('./workspace');

const GH_TIMEOUT_MS = 30000;

function ghRepoView(opts = {}) {
  return spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    ...opts,
  });
}

/**
 * 明示repoまたはworkspaceのGitHub remoteからowner/repoを解決する。
 * GitHub CLIの失敗や空出力は、repo不在として扱わずエラーにする。
 *
 * @param {{repo?:string,workspace?:string}} params
 * @param {{ghRepoViewFn?:Function,resolveWorkspaceFn?:Function}} [deps]
 * @returns {{ok:true,repo:string,workspacePath:string|null}|{ok:false,error:string}}
 */
function resolveRepo({ repo, workspace } = {}, deps = {}) {
  const explicitRepo = typeof repo === 'string' ? repo.trim() : '';
  if (explicitRepo) return { ok: true, repo: explicitRepo, workspacePath: null };

  const resolveWorkspaceFn = deps.resolveWorkspaceFn || resolveWorkspace;
  const workspacePath = resolveWorkspaceFn(workspace);
  if (!workspacePath) {
    return {
      ok: false,
      error: 'ワークスペースを解決できません。--repoを指定するか、.gh-maestro/のあるディレクトリで実行してください。',
    };
  }

  const ghRepoViewFn = deps.ghRepoViewFn || ghRepoView;
  let result;
  try {
    result = ghRepoViewFn({ cwd: workspacePath });
  } catch (error) {
    return {
      ok: false,
      error: `リポジトリの特定に失敗しました: ${error && error.message ? error.message : String(error)}`,
    };
  }
  if (!result || result.error || result.status !== 0) {
    const detail = result && result.error && result.error.message
      ? result.error.message : (result && result.stderr) || '(no stderr)';
    return {
      ok: false,
      error: `リポジトリの特定に失敗しました: ${detail}`,
    };
  }

  const resolvedRepo = String(result.stdout || '').trim();
  if (!resolvedRepo) return { ok: false, error: 'リポジトリ名が空です' };
  return { ok: true, repo: resolvedRepo, workspacePath };
}

module.exports = { GH_TIMEOUT_MS, ghRepoView, resolveRepo };
