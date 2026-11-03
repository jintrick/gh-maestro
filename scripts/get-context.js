#!/usr/bin/env node
// get-context.js
// orchestratorの起動コンテキストを取得してプロンプト注入用ブロックとして出力する

const { execSync } = require('child_process');
const { spawnSync } = require('./shared/child-process');
const fs = require('fs');
const path = require('path');
const { getCurrentBranch } = require('./shared/git-branch');
const { resolveGitHead, SHA_RE } = require('./shared/git-head');
const { managedRoot } = require('./shared/storage-layout');
const { resolveWorkspace } = require('./shared/workspace');
const { readState } = require('./shared/read-state');
const { getTestLayerDeclarationStatus, inspectConfigFileHealth } = require('./shared/resolve-config');
const {
  STATUS: NODE_MODULES_STATUS,
  formatStatusLine,
  inspectNodeModulesStatus,
} = require('./shared/node-modules-status');

// install.js embeds the source tuple in the shared copy and its plugin mirror.
const INSTALL_SOURCE_B64 = '__GH_MAESTRO_INSTALL_SOURCE_UNSET__';
const INSTALL_SOURCE = INSTALL_SOURCE_B64 === '__GH_MAESTRO_INSTALL_SOURCE_UNSET__'
  ? null
  : JSON.parse(Buffer.from(INSTALL_SOURCE_B64, 'base64').toString('utf8'));
const GH_API_TIMEOUT_MS = 15000;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const USAGE = `get-context.js — orchestrator の起動コンテキストをプロンプト注入用ブロックとして出力する

Usage: node get-context.js

引数は取らない。「--workspace」引数相当の指定がないため、GH_MAESTRO_WORKSPACE env、
次にCWDから上方探索して WORKSPACE を解決し、git remote から REPO、現在のブランチから
BASE_BRANCH とテスト層宣言の状態を解決し、GitHub上の遅れとインストール済みコピーの鮮度を確認して
[gh-maestro session context] ブロックを stdout に出力する。鮮度を確認できない場合も開始を止めず理由を出力する。
通常は /gh-maestro の起動フックが呼ぶ。`;

function validateInstallSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('インストール元情報がオブジェクトではありません');
  }
  if (typeof value.reason === 'string' && value.reason) throw new Error(value.reason);
  if (typeof value.repo !== 'string' || !REPO_RE.test(value.repo)) {
    throw new Error('インストール元repoが欠落または不正です');
  }
  if (typeof value.branch !== 'string' || !value.branch || /[\r\n]/.test(value.branch)) {
    throw new Error('インストール元branchが欠落または不正です');
  }
  if (typeof value.commit !== 'string' || !SHA_RE.test(value.commit)) {
    throw new Error('インストール元commitが欠落または不正です');
  }
  return { repo: value.repo, branch: value.branch, commit: value.commit };
}

function readInstalledSource({ installedScriptPath, readFileFn = fs.readFileSync } = {}) {
  if (INSTALL_SOURCE !== null) return validateInstallSource(INSTALL_SOURCE);
  const sourcePath = installedScriptPath || path.join(managedRoot(), 'scripts', 'get-context.js');
  let sourceText;
  try {
    sourceText = readFileFn(sourcePath, 'utf8');
  } catch (error) {
    throw new Error(`インストール済みスクリプトを読み取れません (${sourcePath}): ${error.message}`);
  }
  const match = String(sourceText).match(/^const INSTALL_SOURCE_B64 = '([A-Za-z0-9+/=]+)';$/m);
  if (!match) {
    throw new Error(`インストール済みスクリプトにインストール元情報がありません (${sourcePath})`);
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`インストール済みスクリプトの情報がJSONとして不正です: ${error.message}`);
  }
  if (value === null) throw new Error(`インストール済みスクリプトにインストール元情報がありません (${sourcePath})`);
  return validateInstallSource(value);
}

function compareRemoteCommits({ repo, base, head, cwd, spawnSyncFn = spawnSync }) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) throw new Error(`GitHub repoが不正です: ${JSON.stringify(repo)}`);
  if (typeof base !== 'string' || !base || /[\r\n]/.test(base)) throw new Error('比較元のコミットまたはブランチが不正です');
  if (typeof head !== 'string' || !head || /[\r\n]/.test(head)) throw new Error('比較先のブランチが不正です');
  const endpoint = `repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  let result;
  try {
    result = spawnSyncFn('gh', ['api', endpoint], {
      cwd, encoding: 'utf8', stdio: 'pipe', timeout: GH_API_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`GitHub compare APIを実行できません: ${error.message}`);
  }
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error?.message || String(result?.stderr || '').trim()
      || `終了コード ${result?.status ?? '不明'}`;
    throw new Error(`GitHub compare APIに失敗しました: ${detail}`);
  }
  let response;
  try {
    response = JSON.parse(String(result.stdout || ''));
  } catch (error) {
    throw new Error(`GitHub compare APIのJSONが不正です: ${error.message}`);
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)
      || !Number.isSafeInteger(response.ahead_by) || response.ahead_by < 0) {
    throw new Error('GitHub compare APIのahead_byが欠落または不正です');
  }
  return response.ahead_by;
}

function getFreshnessStatus({
  workspace, repo, repoReason, branch, installedSource, spawnSyncFn = spawnSync,
  resolveHeadFn = resolveGitHead, readInstalledSourceFn = readInstalledSource,
}) {
  const comparisonCache = new Map();
  const compareOnce = (request) => {
    const key = JSON.stringify([request.repo, request.base, request.head]);
    if (comparisonCache.has(key)) {
      const cached = comparisonCache.get(key);
      if (cached.error) throw new Error(cached.error);
      return cached.value;
    }
    try {
      const value = compareRemoteCommits({ ...request, cwd: workspace, spawnSyncFn });
      comparisonCache.set(key, { value });
      return value;
    } catch (error) {
      comparisonCache.set(key, { error: error.message });
      throw error;
    }
  };

  const baseStatus = (() => {
    try {
      if (repoReason) throw new Error(repoReason);
      if (typeof branch !== 'string' || !branch) throw new Error('現在のブランチを確認できません');
      const localHead = resolveHeadFn(workspace);
      if (!SHA_RE.test(localHead)) throw new Error('ローカルHEADの形式が不正です');
      const behindCommits = compareOnce({ repo, base: localHead, head: branch });
      return behindCommits === 0 ? { status: 'up-to-date' } : { status: 'behind', behindCommits };
    } catch (error) {
      return { status: 'unknown', reason: error.message };
    }
  })();

  const installStatus = (() => {
    try {
      const source = validateInstallSource(installedSource === undefined
        ? readInstalledSourceFn() : installedSource);
      const behindCommits = compareOnce({ repo: source.repo, base: source.commit, head: source.branch });
      return behindCommits === 0
        ? { status: 'up-to-date' }
        : { status: 'stale', behindCommits, installedCommit: source.commit };
    } catch (error) {
      return { status: 'unknown', reason: error.message };
    }
  })();
  return { baseStatus, installStatus };
}

function formatFreshnessStatus({ baseStatus, installStatus }) {
  const lines = [];
  if (baseStatus.status === 'behind') {
    lines.push(`BASE_BRANCH_STATUS=behind BEHIND_COMMITS=${baseStatus.behindCommits}`);
  } else if (baseStatus.status === 'unknown') {
    lines.push(`BASE_BRANCH_STATUS=unknown REASON=${JSON.stringify(baseStatus.reason)}`);
  }
  if (installStatus.status === 'stale') {
    lines.push(`GH_MAESTRO_INSTALL_STATUS=stale BEHIND_COMMITS=${installStatus.behindCommits} INSTALLED_COMMIT=${installStatus.installedCommit}`);
  } else if (installStatus.status === 'unknown') {
    lines.push(`GH_MAESTRO_INSTALL_STATUS=unknown REASON=${JSON.stringify(installStatus.reason)}`);
  }
  return lines;
}

module.exports = {
  USAGE, INSTALL_SOURCE, validateInstallSource, readInstalledSource,
  compareRemoteCommits, getFreshnessStatus, formatFreshnessStatus,
};

// CLI として実行されたときだけ動く。require されただけで git を叩き stdout を汚さないため。
if (require.main !== module) return;

if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
  console.log(USAGE);
  process.exit(0);
}

const workspace = resolveWorkspace();
if (!workspace) {
  console.error('ERROR: ワークスペースを解決できません。GH_MAESTRO_WORKSPACE または .gh-maestro/ のあるディレクトリで実行してください。');
  process.exit(1);
}

let repo = '';
let repoReason = '';
try {
  const raw = execSync('git config --get remote.origin.url', { cwd: workspace, encoding: 'utf8' }).trim();
  const match = raw.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  repo = match ? match[1] : raw;
  if (!repo) repoReason = 'remote.origin.urlからGitHub repoを解決できません';
} catch (error) {
  repoReason = `remote.origin.urlを確認できません: ${error.message}`;
}

let baseBranch = '';
try {
  baseBranch = getCurrentBranch(workspace);
} catch {}

let sessionId = '';
try {
  const stateResult = readState(workspace, 'orchestrator');
  if (stateResult.status === 'ok' && typeof stateResult.state.sessionId === 'string' && stateResult.state.sessionId) {
    sessionId = stateResult.state.sessionId;
  }
} catch {}

let testLayersStatus = 'invalid';
try {
  testLayersStatus = getTestLayerDeclarationStatus({ workspace });
} catch {
  // 設定状態の通知は補助情報であり、セッション初期化を止めない。
}

const unixWorkspace = workspace.replace(/\\/g, '/');

console.log('[gh-maestro session context]');
console.log(`REPO=${repo}`);
console.log(`WORKSPACE=${unixWorkspace}`);
if (baseBranch) console.log(`BASE_BRANCH=${baseBranch}`);
console.log('GH_MAESTRO_WORKER=orchestrator');
if (sessionId) console.log(`SESSION_ID=${sessionId}`);
console.log(`TEST_LAYERS_STATUS=${testLayersStatus}`);

// 壊れた config.json（既定値で動いているもの）だけを表示する。壊れていなければ何も出さない（ADR 0053）。
let brokenConfigs = [];
try {
  brokenConfigs = inspectConfigFileHealth({ workspace });
} catch {
  // 表示は補助情報であり、セッション初期化を止めない。
}
for (const broken of brokenConfigs) {
  console.log(`CONFIG_JSON_BROKEN=${broken.path} (${broken.reason})`);
}

const freshness = getFreshnessStatus({ workspace, repo, repoReason, branch: baseBranch });
for (const line of formatFreshnessStatus(freshness)) console.log(line);

let nodeModulesStatus;
try {
  nodeModulesStatus = inspectNodeModulesStatus(workspace);
} catch (error) {
  nodeModulesStatus = { status: NODE_MODULES_STATUS.UNKNOWN, reason: error.message };
}
if (nodeModulesStatus.status !== NODE_MODULES_STATUS.NOT_APPLICABLE
    && nodeModulesStatus.status !== NODE_MODULES_STATUS.OK) {
  console.log(formatStatusLine(nodeModulesStatus));
}
