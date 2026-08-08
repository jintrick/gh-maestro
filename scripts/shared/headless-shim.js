#!/usr/bin/env node
'use strict';
// headless-shim.js — headless ワーカーの中継プロセス
//
// なぜ中継が必要か（Windows実機で確認した制約。Issue #151 Phase 1）:
//   - ワーカーは起動元の使い捨てCLI（spawn-worker.js 等）が終了しても生き続ける必要がある。
//     そのためには detached 起動が要る。detached でないと起動元の終了に巻き込まれて死ぬ。
//   - ところが Windows の detached は DETACHED_PROCESS（コンソール無し）になり、この状態では
//     **pwsh が起動すらしない**（Set-Content 1行すら実行されない）。エージェントは $PROFILE の
//     pwsh 関数として定義されうるため（claude-ds 等）、pwsh ラップは外せない。
//   - 一方 node は detached でも正常に動き、fd 直接リダイレクトも問題なく機能する。
//
// そこで「detached な node（このシム）」を1段挟み、シムが pwsh を**非detached**で起動する。
// コンソールを持たない親から起動される console app は自前のコンソールを割り当てるため、
// DETACHED_PROCESS の制約を受けない。シムは子の終了コードでそのまま終了するので、
// シムの生死 = ワーカーの生死 となり、PIDによる生存確認がそのまま使える。
//
// Usage (launchAgentHeadless が組み立てる固定形):
//   node headless-shim.js <shell-args-json> <log-path>

const fs = require('fs');
const { spawn, spawnSync } = require('../child-process');

const USAGE = `headless-shim.js — headlessワーカーの中継プロセス（gh-maestro内部用）

Usage: node headless-shim.js <shell-args-json> <log-path> [<exit-hook-json>]

Arguments:
  <shell-args-json>  起動するargvのJSON配列（buildLoginShellExecArgs の戻り値）
  <log-path>         標準出力/標準エラーの追記先
  <exit-hook-json>   子終了後に実行する終了フック（任意）

このスクリプトは shared/headless-launch.js が内部的に起動する中継プロセスであり、
人手やエージェントが直接呼ぶことは想定していない。
子プロセスの標準出力/標準エラーをログへ直接リダイレクトし、子の終了コードで終了する。`;

/**
 * shellArgs を非detachedで起動し、標準出力/標準エラーを logPath へ直接リダイレクトする。
 *
 * @param {object} params
 * @param {string[]} params.shellArgs
 * @param {string} params.logPath
 * @param {Function} [params.spawnFn=spawn] - テスト用の注入口
 * @param {(code: number) => void} params.onExit - 子の終了コードを受け取る
 * @returns {object} 起動した子プロセスハンドル
 */
function runShim({ shellArgs, logPath, exitHook = null, spawnFn = spawn,
  spawnSyncFn = spawnSync, onExit }) {
  // 追記で開く。resume も同じファイルへ書き足し、時系列が1本に繋がる。
  const fd = fs.openSync(logPath, 'a');

  let child;
  try {
    child = spawnFn(shellArgs[0], shellArgs.slice(1), {
      // detached にしない。ここが本シムの存在理由（ファイル冒頭の説明を参照）。
      // stdin は pipe で受け取り、起動直後に end() でEOFを送る（下記）。
      // stdout/stderr はログfdへ直接リダイレクト（パイプ経由の複製はしない）。
      stdio: ['pipe', fd, fd],
      windowsHide: true,
    });
  } catch (e) {
    // シム自身の標準出力は捨てられているため、起動失敗をログへ残さないと
    // 「ログが空のまま何も起きない」という追跡不能な状態になる。
    try { fs.writeSync(fd, `\n[gh-maestro] ワーカープロセスの起動に失敗しました: ${e.message}\n`); } catch { /* ログにも書けない場合は諦める */ }
    try { fs.closeSync(fd); } catch { /* 失敗しても報告すべきは起動エラー */ }
    throw e;
  }

  // fd は子へ複製済みなので親側は閉じてよい。
  try { fs.closeSync(fd); } catch { /* 子への複製は済んでいる */ }

  // 子へEOFを明示的に送る。stdin を 'ignore'（WindowsではNUL）にすると、codex 等のCLIが
  // 追加入力待ちのままハングすることがある（Issue #244）。pipe で受け、起動直後に閉じて
  // 入力終了（EOF）を確実に伝える。spawn 失敗時等 child.stdin が無い場合は無視する。
  if (child.stdin) {
    try { child.stdin.end(); } catch { /* 起動失敗等で閉じられない場合は無視 */ }
  }

  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    // 子とその標準出力fdが閉じた後にフックを起動する。Windowsで開いたログへの
    // renameが失敗する原因を、リトライではなくプロセス境界で排除する。
    if (exitHook) {
      try {
        const result = spawnSyncFn(exitHook.command,
          [...(exitHook.args || []), String(code)],
          { stdio: 'ignore', windowsHide: true });
        if (result && (result.error || result.status !== 0)) {
          const detail = result.error?.message || `exit code ${result.status}`;
          try { fs.appendFileSync(logPath, `\n[gh-maestro] 終了フックの実行に失敗しました: ${detail}\n`); } catch {}
        }
      } catch (error) {
        try { fs.appendFileSync(logPath, `\n[gh-maestro] 終了フックの起動に失敗しました: ${error.message}\n`); } catch {}
      }
    }
    onExit(code);
  };

  child.on('error', (e) => {
    try { fs.appendFileSync(logPath, `\n[gh-maestro] ワーカープロセスでエラーが発生しました: ${e.message}\n`); } catch { /* best-effort */ }
    finish(1);
  });
  // 子の終了コードをそのまま引き継ぐ（シムの生死 = ワーカーの生死）。
  // close は子のstdout/stderr fdが閉じた後に発火する。exitではなくcloseを境界に
  // することで、Windowsの共有違反をプロセス順序で防ぐ。
  child.on('close', (code, signal) => finish(code == null ? (signal ? 1 : 0) : code));

  return child;
}

module.exports = { runShim };

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const [shellArgsJson, logPath, exitHookJson] = args;
  if (!shellArgsJson || !logPath || args.length < 2 || args.length > 3) {
    console.error(USAGE);
    process.exit(1);
  }

  let shellArgs;
  try {
    shellArgs = JSON.parse(shellArgsJson);
  } catch (e) {
    console.error(`headless-shim: shell-args-json のパースに失敗しました: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(shellArgs) || shellArgs.length === 0) {
    console.error('headless-shim: shell-args-json は空でない配列である必要があります');
    process.exit(1);
  }

  let exitHook = null;
  if (exitHookJson) {
    try {
      exitHook = JSON.parse(exitHookJson);
      if (!exitHook || typeof exitHook.command !== 'string' || !Array.isArray(exitHook.args)) {
        throw new Error('exit-hook-json の形式が不正です');
      }
    } catch (e) {
      console.error(`headless-shim: exit-hook-json のパースに失敗しました: ${e.message}`);
      process.exit(1);
    }
  }

  try {
    runShim({ shellArgs, logPath, exitHook, onExit: (code) => process.exit(code) });
  } catch {
    // 起動失敗の詳細は runShim がログへ書いている
    process.exit(1);
  }
}
