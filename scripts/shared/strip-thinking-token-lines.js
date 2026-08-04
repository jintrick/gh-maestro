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

const fs = require('fs');

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
  fs.writeFileSync(tmpPath, output, 'utf8');
  fs.renameSync(tmpPath, logPath);

  return { compacted: true, removedLines };
}

module.exports = { compactWorkerLog, isThinkingTokensLine };
