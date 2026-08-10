'use strict';
// write-failure-warning.js — 常駐プロセスが状態ファイル書き込みに連続失敗したときに
// 人間へ警告を送るための共有ヘルパー（Issue #250）。
//
// 常駐プロセス（msg-poll.js / inbox-supervisor.js / assistant-watch.js）は、他プロセスが
// 状態ファイルを掴んでいる等の理由で書き込みが失敗しても停止せず、次サイクルで再試行する
// （atomic-write.js の短時間リトライが救えるのは一瞬の競合のみで、開きっぱなしの競合は
// 呼び出し元の try-catch + 次サイクル再試行が受け止める）。しかし失敗が継続すると状態が
// ディスクに永続化されないまま時間が経過するため、連続失敗が閾値（既定5回≒ポーリング
// 間隔20秒で約100秒相当）に達したら呼び出し元が msg-send.js 経由で orchestrator へ警告する。
// 本ヘルパーはその連続失敗カウントを共通化する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const DEFAULT_WRITE_FAILURE_THRESHOLD = 5;

/**
 * 書き込み失敗の連続回数を追跡するモニターを作る。
 *
 * @param {object} opts
 * @param {(ctx: { count: number, detail: string }) => void} opts.notify
 *   連続失敗が閾値に達したときに1回だけ呼ばれる通知関数。戻り値は使わない。
 * @param {number} [opts.threshold=5] 連続失敗の閾値
 * @returns {{ onSuccess: () => void, onFailure: (detail: string) => void, current: () => number }}
 *   - onSuccess(): 書き込みが成功した。連続失敗カウンタを0に戻す。
 *   - onFailure(detail): 書き込みが失敗した。連続失敗が閾値に達したら notify を呼び、
 *     カウンタを0に戻す（再び閾値分の連続失敗が積もるまで再通知しない）。
 *   - current(): 現在の連続失敗数（テスト・診断用）。
 */
function createWriteFailureMonitor({ notify, threshold = DEFAULT_WRITE_FAILURE_THRESHOLD }) {
  let consecutive = 0;
  return {
    onSuccess() {
      consecutive = 0;
    },
    onFailure(detail) {
      consecutive++;
      if (consecutive >= threshold) {
        const reached = consecutive;
        consecutive = 0;
        notify({ count: reached, detail });
      }
    },
    current() {
      return consecutive;
    },
  };
}

module.exports = { createWriteFailureMonitor, DEFAULT_WRITE_FAILURE_THRESHOLD };
