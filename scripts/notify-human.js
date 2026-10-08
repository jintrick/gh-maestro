#!/usr/bin/env node
'use strict';

const { spawnSync } = require('./shared/child-process');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { resolveRepo } = require('./shared/repo');
const { resolveHumanNotificationConfig } = require('./shared/resolve-config');

const USAGE = `notify-human.js — 人間向けの待機通知を送信する

Usage:
  node notify-human.js [--repo <owner/repo>] [--workspace <path>]
  node notify-human.js --help | -h

Options:
  --repo <owner/repo>  通知本文に使うリポジトリ名（省略時はGitHub remoteから解決）
  --workspace <path>  設定とリポジトリ解決に使うworkspace
  --help, -h           このUsageを表示する

通知先とHTTP methodは scripts/notification-defaults.json、および .gh-maestro/config.json
の humanNotification 設定で変更できます。失敗時は非0で終了します。`;

const SPEC = {
  flags: { '--repo': {}, '--workspace': {} },
  booleans: ['--help', '-h'],
  positionals: { min: 0, max: 0 },
};

function notifyHuman({ repo, workspace }, deps = {}) {
  const resolveWorkspaceFn = deps.resolveWorkspaceFn || resolveWorkspace;
  let resolvedWorkspace;
  try {
    resolvedWorkspace = resolveWorkspaceFn(workspace);
  } catch (error) {
    return { exitCode: 1, stderr: `notify-human: workspace を解決できません: ${error.message}\n` };
  }
  if (workspace && !resolvedWorkspace) {
    return { exitCode: 1, stderr: 'notify-human: 指定された workspace を解決できません\n' };
  }
  const resolveRepoFn = deps.resolveRepoFn || resolveRepo;
  const repoResult = resolveRepoFn({ repo, workspace: resolvedWorkspace || workspace }, deps.repoDeps);
  if (!repoResult || !repoResult.ok) {
    return { exitCode: 1, stderr: `notify-human: ${repoResult?.error || 'リポジトリを解決できません'}\n` };
  }
  const resolveConfigFn = deps.resolveConfigFn || resolveHumanNotificationConfig;
  let config;
  try {
    config = resolveConfigFn({ workspace: repoResult.workspacePath || resolvedWorkspace, homedir: deps.homedir });
  } catch (error) {
    return { exitCode: 1, stderr: `notify-human: 通知設定を読み込めません: ${error.message}\n` };
  }
  if (!config) return { exitCode: 1, stderr: 'notify-human: 通知設定が不正です\n' };

  const spawnSyncFn = deps.spawnSyncFn || spawnSync;
  let result;
  try {
    result = spawnSyncFn('curl', [
      '--fail', '--silent', '--show-error', '--request', config.method,
      '--data-binary', repoResult.repo, config.url,
    ], { encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
  } catch (error) {
    return { exitCode: 1, stderr: `notify-human: curl の実行に失敗しました: ${error.message}\n` };
  }
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message || result?.stderr?.trim() || `curl exit ${result?.status ?? 'unknown'}`;
    return { exitCode: 1, stderr: `notify-human: 通知送信に失敗しました: ${detail}\n` };
  }
  return { exitCode: 0, stdout: '' };
}

function main(argv, deps = {}) {
  let values;
  try {
    ({ values } = parseFlags(argv, SPEC));
  } catch (error) {
    if (error.name !== 'ArgsValidationError') throw error;
    if (error.helpRequested) return { exitCode: 0, stdout: USAGE };
    return { exitCode: 1, stderr: `notify-human: ${error.errors.map(item => item.message).join('\n')}\n${USAGE}` };
  }
  if (values['--help'] || values['-h']) return { exitCode: 0, stdout: USAGE };
  return notifyHuman({ repo: values['--repo'], workspace: values['--workspace'] }, deps);
}

module.exports = { USAGE, SPEC, notifyHuman, main };

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
