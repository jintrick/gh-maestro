'use strict';
// strip-thinking-token-lines.js — ワーカーログから中身のない雑音行を取り除く
//
// claude-ds系（DeepSeek経由のstream-json --verbose出力）は、thinkingブロックの
// トークン数を1個ずつ数え上げる進捗イベントを逐次出力する。1行の例:
//   {"type":"system","subtype":"thinking_tokens","estimated_tokens":348,"estimated_tokens_delta":1,...}
// これは推論内容を一切含まない純粋なカウンタ更新で、1セッションで数万行に達し、
// ログファイルを肥大化させる（実運用で確認済み）。thinking自体（推論の質）には
// 影響を与えず、この進捗イベント行だけを事後的に取り除く。
//
// 呼び出しタイミングの前提: エージェントプロセスが完全に終了し、そのプロセスが
// 開いていたログfdが閉じた後（= 書き込みが一切発生しない区間）でのみ呼ぶこと。
// 実行中のプロセスがまだ追記している最中にこの関数でファイルを置き換えると、
// 追記側は古いinodeへ書き込み続け、新しいパスには反映されず消失する
// （headless-launch.js が生fdリダイレクトを使う設計と同じ理由でパイプを避けている）。
//
// 置き換え（rename）は atomic-write.js の共有リトライ（EACCES/EPERM/EBUSY、合計500ms
// 予算）を使う。Windows ではプロセスの stdio fd が閉じた後も OS がファイルハンドルを
// 即時解放しないことがあり、rename が一時的に EPERM で失敗するため（Issue #258。
// PR #251 / #253 と同型の対策）。リトライを尽くしても失敗した場合は、失敗をログ自体に
// 書き残してから throw する。worker-exit-hook の stderr は headless-shim が
// stdio:'ignore' で起動するため破棄され、その経路だけに頼ると失敗が誰にも届かない。

const fs = require('fs');
const { renameSyncWithRetry } = require('./atomic-write');

/**
 * 1行が「thinking_tokens進捗イベント」であるかを判定する。
 * JSONとしてパースできない行（gh-maestro自身が挿入するエラーメッセージ等）は
 * 無条件で残す（フェイルオープン。誤って有用な行を消さない）。
 *
 * @param {string} line
 * @returns {boolean}
 */
function isThinkingTokensLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return !!obj && obj.type === 'system' && obj.subtype === 'thinking_tokens';
}

/**
 * ログファイルから thinking_tokens 進捗イベント行を取り除く（原子的に置き換え）。
 * 該当行が1つも無ければファイルには触れない（不要な書き込み・rename を避ける）。
 *
 * @param {string} logPath
 * @returns {{ compacted: boolean, removedLines: number }}
 */
function compactWorkerLog(logPath) {
  let content;
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch {
    return { compacted: false, removedLines: 0 };
  }
  if (!content) return { compacted: false, removedLines: 0 };

  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hadTrailingNewline) lines.pop();

  let removedLines = 0;
  const kept = lines.filter((line) => {
    if (isThinkingTokensLine(line)) {
      removedLines++;
      return false;
    }
    return true;
  });

  if (removedLines === 0) return { compacted: false, removedLines: 0 };

  const output = kept.length > 0 ? kept.join('\n') + '\n' : '';
  const tmpPath = `${logPath}.compact-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, output, 'utf8');
    try {
      // Windows の rename EPERM（他プロセスの fd 解放遅延）を吸収する共有リトライ。
      // EACCES/EPERM/EBUSY 以外はリトライせず即 throw する（一時的でないエラーを
      // 無駄にやり直さない）。
      renameSyncWithRetry(tmpPath, logPath);
    } catch (e) {
      // リトライを尽くしても置き換えに失敗した: 失敗をログ自体へ書き残す。
      // ここで書き残さないと、呼び出し元 worker-exit-hook の stderr は headless-shim が
      // stdio:'ignore' で破棄するため、ノイズ行が残ったまま失敗が誰にも届かない。
      try {
        fs.appendFileSync(logPath, `\n[gh-maestro] ログ圧縮に失敗しました（thinking_tokens ノイズ行は残っています）: ${e.message}\n`);
      } catch { /* 追記もできない場合は何もできない。throw は続行する */ }
      throw e;
    }
  } finally {
    // 成功時は rename 後に tmp は存在しないため unlink は ENOENT（無害）、
    // 失敗時（共有違反等で rename が throw）はここで確実に tmp を掃除する
    // （Issue #248 項目10。従来の catch 内 unlink は成功時の tmp 残骸を
    // 残しうる構造だった）。
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  return { compacted: true, removedLines };
}

module.exports = { compactWorkerLog, isThinkingTokensLine };
