'use strict';
// workers.json のエントリを正規化・構築する。
//
// 新形式: { pid, startTime, logPath, agentId, issue, skill }。
//   pid/startTime — headless起動したワーカープロセスの識別。生存確認は pid だけでなく
//     startTime との組で行う（OSがPIDを再利用したとき、無関係なプロセスを「稼働中」と
//     誤判定し続けるのを防ぐ。scripts/shared/worker-liveness.js 参照）。
//   logPath — ワーカーの標準出力/標準エラーの記録先。1ワーカー1ファイルで追記される。
//   agentId — エージェントごとに異なる挙動を後段で切り替えるための情報。
//   issue/skill — orchestrator が workerName を覚えずに〈issue + skill〉でワーカーを
//     指せるようにするための識別子（resolveWorkerName 参照）。agentId は役割と1対1で
//     ないため判別に使えない。
//
// レガシー: paneId / notifierPid は、WezTermペイン運用時代（Issue #151 以前）に
// 起動されたワーカーのエントリを読むためだけに残している。新規登録では設定されない。
// 移行前セッションが残したペイン・プロセスを掃除する経路が、これらを読んで動く。
// 旧形式（pane_id文字列のみ）で書かれた既存の workers.json とも後方互換に読める。
//
// spawn-worker.js が新規ワーカーを登録する際も、この関数に候補値を渡して
// 正規化済みエントリを構築する（生成用の別関数を持たず、正規化ロジックを一本化する）。

/**
 * PIDとして妥当な正の整数なら Number を、そうでなければ null を返す。
 * 文字列・浮動小数・0以下・NaN はすべて不正として弾く（不正PIDでのkill/生存判定を防ぐ）。
 * @param {unknown} v
 * @returns {number|null}
 */
function normalizePid(v) {
  // 型を先に絞る。boolean は Number(true) === 1 となり、素通しすると PID 1 として
  // 扱われてしまう（Windowsでは System Idle Process、Unixでは init）。
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeWorkerEntry(v) {
  if (v && typeof v === 'object') {
    return {
      pid: normalizePid(v.pid),
      startTime: typeof v.startTime === 'string' ? v.startTime : null,
      logPath: typeof v.logPath === 'string' ? v.logPath : null,
      agentId: v.agentId ?? null,
      issue: v.issue != null ? Number(v.issue) : null,
      skill: v.skill ?? null,
      // ── レガシー（移行前セッションの掃除にのみ使う） ──
      paneId: v.paneId != null ? String(v.paneId) : null,
      notifierPid: v.notifierPid ?? null,
    };
  }
  // 最旧形式: pane_id 文字列そのものがエントリだった時代
  return {
    pid: null, startTime: null, logPath: null,
    agentId: null, issue: null, skill: null,
    paneId: v != null ? String(v) : null, notifierPid: null,
  };
}

module.exports = { normalizeWorkerEntry, normalizePid };
