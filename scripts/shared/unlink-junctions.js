'use strict';
// scripts/shared/unlink-junctions.js
// worktree 内の junction / symlink を安全に除去するユーティリティ。
//
// Windows の junction は lstatSync では isDirectory()=true / isSymbolicLink()=false と
// 見える環境があるため、isSymbolicLink() チェックだけでは除去も検出もできない。
// rmdirSync を試みることで判断する：
//   - junction → リンク自体だけ除去（ターゲットの中身は一切消えない）
//   - 実ディレクトリ（中身あり） → ENOTEMPTY で再帰
//   - 実ディレクトリ（空） → 削除（worktree 削除の前処理なので無害）
//
// 削除系の呼び出し元は unlinkJunctionsAndVerify を使う。こちらは外し終えたかを確かめ、
// 外せなかった・判定できなかった場合は throw する（Issue #737。git worktree remove --force は
// junction をたどり、リンク先の中身まで消すため、リンクが残ったまま呼んではならない）。
// 検証側は isSymbolicLink() に加え readlink で junction を検出する（判定の取りこぼし＝リンク先の走査を防ぐ）。

const { existsSync, readdirSync, lstatSync, readlinkSync, rmdirSync } = require('fs');
const { resolve } = require('path');

const CODE_REMAIN = 'WORKTREE_LINKS_REMAIN';
const CODE_UNVERIFIABLE = 'WORKTREE_LINKS_UNVERIFIABLE';

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

function linkGuardError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/**
 * 検証失敗（リンクが残った／判定できなかった）を表すエラーか。
 * 呼び出し元は、このエラーを握り潰して後続の削除（rmSync・prune・再作成）へ進んではならない。
 */
function isLinkGuardError(err) {
  return Boolean(err) && (err.code === CODE_REMAIN || err.code === CODE_UNVERIFIABLE);
}

// ディレクトリ項目がリンク（symlink / junction）かどうか。リンクはたどらない。
// 通常ディレクトリは readlink が EINVAL になる。それ以外の失敗は判定不能として扱う。
function isLinkEntry(fullPath, st, readlinkFn) {
  if (st.isSymbolicLink()) return true;
  if (!st.isDirectory()) return false;
  try {
    readlinkFn(fullPath);
    return true;
  } catch (e) {
    if (e.code === 'EINVAL') return false;
    throw linkGuardError(CODE_UNVERIFIABLE,
      `readlink 失敗のためリンクを確認できません: ${fullPath} — ${e.message}`);
  }
}

/**
 * junction / symlink を除去したうえで、木の中にリンクが残っていないことを確かめる。
 * 削除系の呼び出し元は、この関数が throw しなかったときだけ dir を削除してよい。
 *
 * 残ったリンク、または readdir / lstat / readlink の失敗（外せたか判定できない状態）は throw する。
 * リンク先はたどらない。dir が存在しなければ何もしない。
 *
 * @param {string} dir
 * @param {{unlinkFn?: Function, lstatFn?: Function, readlinkFn?: Function}} [options]
 *   テスト用の注入点。既定は unlinkJunctions / lstatSync / readlinkSync。
 * @returns {void}
 * @throws {Error} code='WORKTREE_LINKS_REMAIN' — リンクが残った（paths を持つ）
 * @throws {Error} code='WORKTREE_LINKS_UNVERIFIABLE' — 判定できなかった
 */
function unlinkJunctionsAndVerify(dir, options = {}) {
  if (!existsSync(dir)) return;
  const unlinkFn = options.unlinkFn || unlinkJunctions;
  const lstatFn = options.lstatFn || lstatSync;
  const readlinkFn = options.readlinkFn || readlinkSync;
  unlinkFn(dir, () => {});
  const remaining = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current); } catch (e) {
      throw linkGuardError(CODE_UNVERIFIABLE,
        `readdir 失敗のためリンクを確認できません: ${current} — ${e.message}`);
    }
    for (const entry of entries) {
      const fullPath = resolve(current, entry);
      let st;
      try { st = lstatFn(fullPath); } catch (e) {
        throw linkGuardError(CODE_UNVERIFIABLE,
          `lstat 失敗のためリンクを確認できません: ${fullPath} — ${e.message}`);
      }
      if (isLinkEntry(fullPath, st, readlinkFn)) remaining.push(fullPath);
      else if (st.isDirectory()) walk(fullPath);
    }
  };
  walk(dir);
  if (remaining.length > 0) {
    throw linkGuardError(CODE_REMAIN,
      `リンクを外せませんでした: ${remaining.join(', ')}`, { paths: remaining });
  }
}

module.exports = { unlinkJunctions, unlinkJunctionsAndVerify, isLinkGuardError };
