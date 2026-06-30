'use strict';
// scripts/link-node-modules.js
// worktreeにnodeモジュールのjunctionを作成するユーティリティ。
// spawn-worker.jsから抽出してテスト可能にしたもの。

const { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } = require('fs');
const { resolve, relative } = require('path');

/**
 * workspaceに存在するnode_modulesをすべてworktreeの同じ相対パスにjunctionで張る。
 *
 * worktree側のpackage.jsonの有無を起点にすると、hoisted構成（npm workspaces等）で
 * サブパッケージのnode_modulesが存在しないケースをmissingと誤判定する。
 * workspaceを起点にすることで「あるものだけ張る」設計になり誤報がなくなる。
 *
 * @returns {{ linked: string[], skipped: string[], missing: string[] }}
 *   linked  - junction作成に成功したdestinationパス一覧
 *   skipped - 既にdestが存在したためスキップしたパス一覧
 *   missing - junction作成でエラーが発生したパス一覧（本当のエラーのみ）
 */
function linkNodeModules(worktreeDir, workspace) {
  const linked = [];
  const skipped = [];
  const missing = [];

  (function walk(dir, depth) {
    if (depth > 5) return;

    let entries;
    try { entries = readdirSync(dir); } catch { return; }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue;

      const srcChild = resolve(dir, entry);
      try { if (!statSync(srcChild).isDirectory()) continue; } catch { continue; }

      if (entry === 'node_modules') {
        const dest = resolve(worktreeDir, relative(workspace, srcChild));

        if (existsSync(dest)) {
          skipped.push(dest);
        } else {
          mkdirSync(resolve(dest, '..'), { recursive: true });
          try {
            symlinkSync(srcChild, dest, 'junction');
            linked.push(dest);
          } catch (e) {
            missing.push(`${dest} (error: ${e.message})`);
          }
        }
        // node_modules の中には再帰しない
      } else {
        walk(srcChild, depth + 1);
      }
    }
  })(workspace, 0);

  return { linked, skipped, missing };
}

module.exports = { linkNodeModules };
