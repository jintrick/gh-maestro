'use strict';
// scripts/shared/unlink-junctions.js
// worktree 内の junction / symlink を安全に除去するユーティリティ。
//
// Windows の junction は lstatSync では isDirectory()=true / isSymbolicLink()=false と
// 見えるため、isSymbolicLink() チェックだけでは除去できない。
// rmdirSync を試みることで判断する：
//   - junction → リンク自体だけ除去（ターゲットの中身は一切消えない）
//   - 実ディレクトリ（中身あり） → ENOTEMPTY で再帰
//   - 実ディレクトリ（空） → 削除（worktree 削除の前処理なので無害）
//
// 削除系の呼び出し元は unlinkJunctionsAndVerify を使う。こちらは外し終えたかを確かめ、
// 外せなかった・判定できなかった場合は throw する（Issue #737。git worktree remove --force は
// junction をたどり、リンク先の中身まで消すため、リンクが残ったまま呼んではならない）。

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

/**
 * junction / symlink を除去したうえで、木の中にリンクが残っていないことを確かめる。
 * 削除系の呼び出し元は、この関数が throw しなかったときだけ dir を削除してよい。
 *
 * 残ったリンク、または readdir / lstat の失敗（外せたか判定できない状態）は throw する。
 * リンク先はたどらない（lstat のみ）。dir が存在しなければ何もしない。
 *
 * @param {string} dir
 * @param {{unlinkFn?: Function}} [options] - テスト用の注入点（既定は unlinkJunctions）
 * @returns {void}
 * @throws {Error} code='WORKTREE_LINKS_REMAIN' — リンクが残った（paths を持つ）
 * @throws {Error} code='WORKTREE_LINKS_UNVERIFIABLE' — 判定できなかった
 */
function unlinkJunctionsAndVerify(dir, options = {}) {
  if (!existsSync(dir)) return;
  const unlinkFn = options.unlinkFn || unlinkJunctions;
  unlinkFn(dir, () => {});
  const remaining = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current); } catch (e) {
      const err = new Error(`readdir 失敗のためリンクを確認できません: ${current} — ${e.message}`);
      err.code = 'WORKTREE_LINKS_UNVERIFIABLE';
      throw err;
    }
    for (const entry of entries) {
      const fullPath = resolve(current, entry);
      let st;
      try { st = lstatSync(fullPath); } catch (e) {
        const err = new Error(`lstat 失敗のためリンクを確認できません: ${fullPath} — ${e.message}`);
        err.code = 'WORKTREE_LINKS_UNVERIFIABLE';
        throw err;
      }
      if (st.isSymbolicLink()) remaining.push(fullPath);
      else if (st.isDirectory()) walk(fullPath);
    }
  };
  walk(dir);
  if (remaining.length > 0) {
    const err = new Error(`リンクを外せませんでした: ${remaining.join(', ')}`);
    err.code = 'WORKTREE_LINKS_REMAIN';
    err.paths = remaining;
    throw err;
  }
}

module.exports = { unlinkJunctions, unlinkJunctionsAndVerify };
