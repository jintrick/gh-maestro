'use strict';
// workers-registry.js — workers.json への書き込みヘルパー
//
// inbox-supervisor.js は元々 workers.json を読み取り専用で扱っていたが（loadWorkers()）、
// resumeによるプロセス再起動後は新しいpid/startTimeを書き戻す必要がある。
// spawn-worker.js の新規登録とは異なり、既存エントリのプロセス識別フィールドのみを
// 更新する用途に絞った、最小限の共有ヘルパー。

const fs = require('fs');
const path = require('path');
const { normalizeWorkerEntry, normalizePid } = require('./worker-entry');

/**
 * workspace の workers.json パスを返す。
 * @param {string} workspace
 * @returns {string}
 */
function workersJsonPath(workspace) {
  return path.join(workspace, '.gh-maestro', 'workers.json');
}

/**
 * 既定のスリープ: Atomics.wait による同期的な短時間待機。
 * @param {number} ms
 */
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * workers.json を読み込む。ファイルが存在しない場合のみ null を返す。
 *
 * 「ファイルが存在するのに読み取り・parse・型検証に失敗した」場合は throw する。
 * 旧契約は parse 失敗・型不正も null に返し、「ファイル不在」と conflate していたため、
 * 呼び出し側は existsSync の事後補正で区別せざるを得ず、区別し忘れると破損を「ワーカー
 * ゼロ件」と誤解釈して危険な処理（稼働中ワーカーのログ整理等）を続行した（Issue #275
 * 項目1）。新契約は不在のみ null、それ以外は throw で区別する。
 *
 * JSON.parse 失敗は、別プロセス（spawn-worker.js等）が書き込み中で、tmp→rename
 * アトミック書き込みの最中に部分内容を読んだ場合に起こりうる。書き込み完了を待って
 * 短いリトライを行い、書き込み中の読み取りで保護ロジック全体が無効化される事態を
 * 防ぐ（Issue #248 項目12）。リトライを消費しても parse できない場合は throw する。
 * 型不正（配列・null・プリミティブ）は書き込み中の部分内容では起こり得ないため
 * リトライせず即 throw する。
 *
 * @param {string} workspace
 * @param {{readFileFn?: (p: string) => string, sleepFn?: (ms: number) => void, maxAttempts?: number, delayMs?: number}} [opts]
 *   テスト容易性のための注入点。既定は fs.readFileSync と Atomics.wait。
 * @returns {object|null} ファイル不在のみ null。それ以外の読み取り・parse・型検証失敗は throw。
 */
function readWorkersRaw(workspace, {
  readFileFn = (p) => fs.readFileSync(p, 'utf8'),
  sleepFn = defaultSleep,
  maxAttempts = 5,
  delayMs = 20,
} = {}) {
  const p = workersJsonPath(workspace);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 各試行の冒頭で再読込する（parse 失敗からの再試行時は新しい内容を読む）。
    // 読み取りエラーは「ファイル不在（ENOENT）のみ null」を 1 箇所で完結させる。
    let content;
    try {
      content = readFileFn(p);
    } catch (e) {
      // ENOENT（ファイル不在）のみ null。それ以外の読み取りエラー（権限・ディレクトリ等）は
      // throw して呼び出し側に知らせる。不在を null にするのは正常な空状態だが、存在するのに
      // 読めない状態を null に握りつぶすと「ワーカーが誰もいない」と誤判断される。
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
    let raw;
    try {
      raw = JSON.parse(content);
    } catch {
      // 書き込み中（tmp→rename）の部分読み取りは完了を待って再読込してリトライする。
      if (attempt < maxAttempts) {
        sleepFn(delayMs);
        continue;
      }
      throw new Error(`workers.json を解析できません（${p}）`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`workers.json の形式が不正です（オブジェクトでない）: ${p}`);
    }
    return raw;
  }
}

/**
 * 既存workerエントリのプロセス識別フィールド（pid/startTime/logPath）を更新する。
 * アトミック書き込み（tmp → rename）。
 * workerNameのエントリが存在しない場合は何もせずfalseを返す。
 *
 * 書き戻しはホワイトリスト再構築ではなく既存エントリの引き継ぎで行い、既知の一覧に
 * 載っていないフィールドも保持する（Issue #278）。新フィールドを追加した際に、書き戻しの
 * たびに黙って消える事故を構造的に排除する。
 *
 * resume でワーカーを再起動したときに呼ぶ。移行前セッションが残した paneId は
 * ここで消す——新しいプロセスが起きた以上、古いペインIDは掃除経路にとっても
 * 誤った対象であり、残すと無関係なペインをkillしうる。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @param {{pid: number, startTime: string|null, logPath: string|null}} process
 * @returns {boolean} エントリが存在し更新に成功した場合は true、エントリ不在の場合は false。
 *   readWorkersRaw の契約どおり、レジストリ破損・読み取り不能は throw する（Issue #275 項目1）。
 *   呼び出し側は false を「エントリ不在」として扱い、破損は例外として区別して報告すること。
 *   破損を false に潰すと、呼び出し側（inbox-supervisor の resume）が「ワーカーが見つから
 *   ない」と誤報告し、診断を誤誘導する。
 */
function updateWorkerProcess(workspace, workerName, { pid, startTime = null, logPath = null }) {
  const p = workersJsonPath(workspace);
  // readWorkersRaw は不在のみ null、破損は throw する。エントリ不在のみ false にし、
  // 破損は例外のまま呼び出し側へ伝播させる（不在と破損を取り違えようのない形にする）。
  const raw = readWorkersRaw(workspace);
  if (!raw || !(workerName in raw)) return false;

  // 書き戻しは既存エントリを引き継ぐ。normalizeWorkerEntry は既知フィールドの正規化
  // （issue の数値化・baseBranch 空文字→null 等）に使うが、そのホワイトリストに載って
  // いないフィールドは返すオブジェクトに含まれず、そのまま書き戻すと黙って消える
  // （Issue #278）。そこで既存エントリを先にスプレッドし、その上に正規化結果を重ねることで、
  // 「既知フィールドは従来どおり正規化し、未知フィールドは保持する」を両立する。
  // 最旧形式（エントリが pane_id 文字列そのもの）はオブジェクトでないためスプレッドせず
  // 正規化のみで扱う——文字列をスプレッドすると数値キーに分解されレコードを汚染する。
  const prev = raw[workerName];
  const entry = (prev !== null && typeof prev === 'object' && !Array.isArray(prev))
    ? { ...prev, ...normalizeWorkerEntry(prev) }
    : normalizeWorkerEntry(prev);
  entry.pid = normalizePid(pid);
  entry.startTime = startTime;
  entry.logPath = logPath ?? entry.logPath;
  entry.paneId = null;
  raw[workerName] = entry;

  const tmp = p + '.' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return true;
}

/**
 * 〈issue番号 + skill（役割）〉から workerName を解決する。
 *
 * orchestrator が workerName という文字列を記憶せず、意識している情報（対象Issue番号と
 * 役割）だけでワーカーを指せるようにするための逆引き。真の記録は workers.json であり、
 * orchestrator のLLM文脈記憶に依存しない。
 *
 * 一意に決まる場合だけ workerName を返す。0件・複数件は解決不能として Error を投げる
 * （複数件時はメッセージに候補 workerName を列挙する。曖昧な場合は呼び出し元が
 * workerName を位置引数で明示する運用）。
 *
 * @param {string} workspace
 * @param {{issue: string|number, skill: string}} criteria
 * @returns {string} 一意に決まった workerName
 * @throws {Error} 該当0件、または複数件で一意に決まらない場合
 */
function resolveWorkerName(workspace, { issue, skill }) {
  if (issue == null || issue === '') throw new Error('resolveWorkerName: issue が必要です');
  if (!skill) throw new Error('resolveWorkerName: skill が必要です');

  // readWorkersRaw は不在のみ null、破損は throw する。不在（null）のみ「読み込めません」に
  // 落とし、破損は例外をそのまま伝播させる。「まだ1件もワーカーを起動していない正常な空状態」
  // と「ファイルが壊れている」を同一メッセージに潰すと、前者は放置してよいのに後者は介入が
  // 要る、という区別ができなくなる（Issue #275 項目1）。
  const raw = readWorkersRaw(workspace);
  if (!raw) throw new Error(`workers.json を読み込めません（${workspace}）`);

  const wantIssue = Number(issue);
  const matches = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (name === 'orchestrator') continue;
    const normalized = normalizeWorkerEntry(entry);
    if (normalized.issue === wantIssue && normalized.skill === skill) {
      matches.push(name);
    }
  }

  if (matches.length === 0) {
    throw new Error(`該当するワーカーが見つかりません（issue=${wantIssue}, skill=${skill}）。既に削除済みか、まだ起動していない可能性があります。`);
  }
  if (matches.length > 1) {
    throw new Error(
      `issue=${wantIssue}, skill=${skill} に複数のワーカーが該当し一意に決まりません。` +
      `workerName（位置引数）で明示してください。候補: ${matches.join(', ')}`
    );
  }
  return matches[0];
}

module.exports = {
  workersJsonPath,
  readWorkersRaw,
  updateWorkerProcess,
  resolveWorkerName,
};
