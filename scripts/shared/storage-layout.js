'use strict';
// storage-layout.js — managed root（installerが権威的に管理する領域）と
// runtime root（実行中プロセスがPID/lock等の可変状態を書く領域）の所有権契約。
//
// Issue #214: install.js の prune が `~/.gh-maestro/` 配下を「未知のトップレベルは
// 削除する」allow-list方式で権威的に管理しているため、稼働中プロセスの状態
// （PIDレジストリ）を誤ってこの領域に書くと install 実行のたびに削除される。
// managed root と runtime root を物理的に別ルートへ分離し、両者のパスをこの
// モジュールから宣言的に払い出すことで、新しいコード経路が誤って managed root
// 配下にランタイム状態を書く事故を構造的に防ぐ。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const IS_WIN = process.platform === 'win32';

/**
 * installer が権威的に prune する領域。従来の `~/.gh-maestro/` と同一。
 * @returns {string}
 */
function managedRoot() {
  return path.join(os.homedir(), '.gh-maestro');
}

/**
 * installer が一切 prune しない、実行時状態（PID/lock等）専用の領域。
 * `GH_MAESTRO_RUNTIME_DIR` で明示 override 可能（テスト・隔離実行・将来のportable構成用）。
 *
 * @returns {string}
 */
function runtimeRoot() {
  if (process.env.GH_MAESTRO_RUNTIME_DIR) {
    return path.resolve(process.env.GH_MAESTRO_RUNTIME_DIR);
  }
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA
      || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'gh-maestro', 'runtime-v1');
  }
  const stateHome = process.env.XDG_STATE_HOME
    || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'gh-maestro', 'runtime-v1');
}

/**
 * workspace パスを正規化する。symlink/junctionを可能な限り解決し（realpath）、
 * Windows ではドライブ文字・区切り文字・大小文字の差異を吸収する。
 * realpath が失敗する場合（パス未存在等）は resolve のみ行う。
 *
 * @param {string} p
 * @returns {string}
 */
function canonicalWorkspace(p) {
  let resolved;
  try {
    resolved = fs.realpathSync(p);
  } catch {
    resolved = path.resolve(p);
  }
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

/**
 * canonical workspace の安定した識別子（SHA-256 hex）を返す。
 * @param {string} p
 * @returns {string}
 */
function workspaceKey(p) {
  return crypto.createHash('sha256').update(canonicalWorkspace(p)).digest('hex');
}

/**
 * workspace 固有の runtime ディレクトリを返す（純粋関数、副作用なし）。
 * @param {string} p
 * @returns {string}
 */
function workspaceRuntimeDir(p) {
  return path.join(runtimeRoot(), 'workspaces', workspaceKey(p));
}

/**
 * workspace runtime ディレクトリを作成し、診断用の workspace.json（正規パスの記録）を
 * まだ無ければ書き込む。
 *
 * @param {string} p
 * @returns {string} 作成したディレクトリパス
 */
function ensureWorkspaceRuntimeDir(p) {
  const dir = workspaceRuntimeDir(p);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'workspace.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      canonicalPath: canonicalWorkspace(p),
    }, null, 2), 'utf8');
  }
  return dir;
}

/**
 * runtime root に登録されている workspace をすべて列挙する。
 *
 * install.js は実行元の CWD ではなく、マシン共有の resident registry を更新する。
 * workspace.json の canonicalPath とディレクトリ名（workspaceKey）の両方を検証し、
 * 記録を読み取れない workspace を黙って見落とさない。
 *
 * @returns {string[]} 正規化済みの workspace 絶対パス
 * @throws {Error} registry の列挙・manifest 読み取り・内容検証に失敗した場合
 */
function listRegisteredWorkspaces() {
  assertDisjointRoots();
  const workspacesRoot = path.join(runtimeRoot(), 'workspaces');
  let entries;
  try {
    entries = fs.readdirSync(workspacesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`workspace registry を列挙できません: ${workspacesRoot}: ${error.message}`, { cause: error });
  }

  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const workspaceDir = path.join(workspacesRoot, entry.name);
    const manifestPath = path.join(workspaceDir, 'workspace.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`workspace registry を読み取れません: ${manifestPath}: ${error.message}`, { cause: error });
    }

    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.schemaVersion !== 1 || typeof manifest.canonicalPath !== 'string'
      || !path.isAbsolute(manifest.canonicalPath)) {
      throw new Error(`workspace registry のmanifestが不正です: ${manifestPath}`);
    }

    const workspace = canonicalWorkspace(manifest.canonicalPath);
    try {
      assertValidWorkspace(workspace);
    } catch (error) {
      throw new Error(`workspace registry のworkspaceが不正です: ${manifestPath}: ${error.message}`, { cause: error });
    }
    if (workspaceKey(workspace) !== entry.name) {
      throw new Error(`workspace registry のキーが一致しません: ${manifestPath}`);
    }
    workspaces.push(workspace);
  }
  return workspaces;
}

function samePath(a, b) {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isAncestorOrSame(ancestor, candidate) {
  if (samePath(ancestor, candidate)) return true;
  const rel = path.relative(ancestor, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * workspace が managed root と衝突しないことを検証する。fail-closed: 安全と
 * 確認できない場合は throw する（`.claude/rules/fail-closed-safety-guards.md` 準拠）。
 *
 * Issue #214 の根本原因（workspace がホームディレクトリに誤解決され、
 * `~/.gh-maestro/pids` が installer の管理領域に作られてしまう）を、
 * PID registry 等のパスを組み立てる全チョークポイントで実行時に遮断する。
 *
 * @param {string} p
 * @throws {Error} workspace が home / managed root と同一・祖先・子孫関係の場合
 */
function assertValidWorkspace(p) {
  const canonical = canonicalWorkspace(p);
  const home = canonicalWorkspace(os.homedir());
  const managed = canonicalWorkspace(managedRoot());

  if (samePath(canonical, home)) {
    throw new Error(
      `assertValidWorkspace: workspace がホームディレクトリ (${home}) に解決されました。`
      + ` install.js の管理領域と衝突するため拒否します。`
    );
  }
  if (isAncestorOrSame(canonical, managed) || isAncestorOrSame(managed, canonical)) {
    throw new Error(
      `assertValidWorkspace: workspace (${canonical}) が managed root (${managed}) と`
      + ` 祖先・子孫関係にあります。拒否します。`
    );
  }
}

/**
 * managed root と runtime root が物理的に分離されていることを検証する。
 * 起動時の自己検査として使う。
 *
 * @throws {Error} 両ルートが同一・祖先・子孫関係の場合
 */
function assertDisjointRoots() {
  const managed = canonicalWorkspace(managedRoot());
  const runtime = canonicalWorkspace(runtimeRoot());
  if (isAncestorOrSame(managed, runtime) || isAncestorOrSame(runtime, managed)) {
    throw new Error(
      `assertDisjointRoots: managed root (${managed}) と runtime root (${runtime}) が`
      + ` 分離されていません。`
    );
  }
}

/**
 * install.js が権威的に管理するトップレベルエントリの静的宣言。
 * ここに無い名前を ghMaestroPath() で組み立てようとした場合は install.js 側で
 * throw する（登録漏れの実行時検知）。
 */
const MANAGED_TOP_LEVEL = new Set(['scripts', 'skills', 'config.json', 'agents.json']);

module.exports = {
  managedRoot,
  runtimeRoot,
  canonicalWorkspace,
  workspaceKey,
  workspaceRuntimeDir,
  ensureWorkspaceRuntimeDir,
  listRegisteredWorkspaces,
  assertValidWorkspace,
  assertDisjointRoots,
  MANAGED_TOP_LEVEL,
};
