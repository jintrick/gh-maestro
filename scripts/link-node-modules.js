'use strict';
// scripts/link-node-modules.js
// worktreeにnodeモジュールのjunctionを作成するユーティリティ。
// spawn-worker.jsから抽出してテスト可能にしたもの。

const { existsSync, readdirSync, statSync, symlinkSync } = require('fs');
const { resolve, relative } = require('path');

/**
 * worktreeDir配下のpackage.jsonを再帰的に探し、
 * 対応するworkspace側のnode_modulesをjunctionで参照させる。
 * @returns {{ linked: string[], skipped: string[], missing: string[] }}
 *   linked  - junction作成に成功したdestinationパス一覧
 *   skipped - 既にdestが存在したためスキップしたパス一覧
 *   missing - srcが存在せずjunction作成できなかったパス一覧
 */
function linkNodeModules(worktreeDir, workspace) {
  const linked = [];
  const skipped = [];
  const missing = [];

  (function walk(dir, depth) {
    if (depth > 3) return;

    const pkgJson = resolve(dir, 'package.json');
    if (existsSync(pkgJson)) {
      const relPath = relative(worktreeDir, dir);
      const srcModules  = resolve(workspace, relPath, 'node_modules');
      const destModules = resolve(dir, 'node_modules');

      if (existsSync(destModules)) {
        skipped.push(destModules);
      } else if (!existsSync(srcModules)) {
        missing.push(srcModules);
      } else {
        try {
          symlinkSync(srcModules, destModules, 'junction');
          linked.push(destModules);
        } catch (e) {
          missing.push(`${destModules} (error: ${e.message})`);
        }
      }
    }

    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const child = resolve(dir, entry);
      try {
        if (statSync(child).isDirectory()) walk(child, depth + 1);
      } catch { /* skip */ }
    }
  })(worktreeDir, 0);

  return { linked, skipped, missing };
}

module.exports = { linkNodeModules };
