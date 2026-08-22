'use strict';
// scripts/unlink-junctions.js
// worktree 内の junction / symlink を安全に除去するユーティリティ。
//
// Windows の junction は lstatSync では isDirectory()=true / isSymbolicLink()=false と
// 見えるため、isSymbolicLink() チェックだけでは除去できない。
// rmdirSync を試みることで判断する：
//   - junction → リンク自体だけ除去（ターゲットの中身は一切消えない）
//   - 実ディレクトリ（中身あり） → ENOTEMPTY で再帰
//   - 実ディレクトリ（空） → 削除（worktree 削除の前処理なので無害）

const { existsSync, readdirSync, lstatSync, rmdirSync } = require('fs');
const { resolve } = require('path');

function unlinkJunctions(dir, warn) {
  const _warn = typeof warn === 'function' ? warn : () => {};
  if (!existsSync(dir)) return;
  let entries;
  try { entries = readdirSync(dir); } catch (e) {
    _warn(`readdirSync 失敗: ${dir} — ${e.message}`);
    return;
  }
  for (const entry of entries) {
    const fullPath = resolve(dir, entry);
    try {
      const st = lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        rmdirSync(fullPath);
      } else if (st.isDirectory()) {
        try {
          rmdirSync(fullPath);
        } catch (e2) {
          if (e2.code === 'ENOTEMPTY') unlinkJunctions(fullPath, _warn);
          // EBUSY 等はスキップ（robocopy /XJ が守る）
        }
      }
    } catch (e) {
      _warn(`junction除去失敗: ${fullPath} — ${e.message}`);
    }
  }
}

module.exports = { unlinkJunctions };
