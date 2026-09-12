'use strict';
// atomic-write.js — JSONファイルの原子的書き出し（staging → rename）を共有化する
// 汎用ヘルパー。
//
// 背景: finalize-review.js（findings JSON）と run-council.js（council state）が
// それぞれ「親ディレクトリ確保 → 一時ファイルへ JSON.stringify(_, null, 2) 書込み →
// renameSync → 失敗時 unlink」を独立に実装していた（Issue #232 反省会指摘 #1）。
// 書き込み途中のクラッシュで対象ファイルが破損するのを防ぎ、rename は同一
// ファイルシステム上でのみ原子的。
//
// 契約: エラーは throw。成功/失敗の返り値形式は呼び出し元の契約に合わせて
// 呼び出し元側で定める（finalize-review.js は {success,error}、run-council.js は
// throw のまま）。
//
// rename の短時間リトライ（Issue #250）:
//   Windows では、他プロセスが対象ファイルを開いている（Zed 等のエディタが開いた
//   state ファイルを掴んでいる）だけで rename が EPERM で失敗し、それが未捕捉例外に
//   なると常駐プロセス（msg-poll.js / worker-supervisor.js / assistant-watch.js）を
//   クラッシュさせる。graceful-fs の Windows 向け polyfill（polyfills.js の fs.rename
//   ラッパー）を参考に、EACCES/EPERM/EBUSY の間だけ合計予算の範囲でリトライする。
//   ただし graceful-fs の 60 秒リトライは常駐プロセスの応答性を損なうため、
//   RENAME_RETRY_BUDGET_MS（500ms）に短縮する。
//   リトライ可否の判定は graceful-fs の「対象の消失（fs.stat の ENOENT）」ではなく
//   「staging の存在」で行う。対象（state/cursor 等）は上書き対象として常に存在し、
//   原文の判定ではリトライが発火しないため。rename は原子的で、成功すれば staging は
//   必ず消える。staging が残っていれば rename は未完了（リトライ可能）、消えていれば
//   実際に成功済み（エラーは誤検出）＝成功扱いで返す。
//   このリトライが救えるのは一瞬の競合のみで、実機で確認した「開きっぱなし」の競合は
//   予算を使い切って失敗する。それでもプロセスを止めないのは、各呼び出し元（msg-poll /
//   worker-supervisor / assistant-watch）の try-catch + 次サイクル再試行の責務であり、
//   本モジュールはその失敗を「即時 throw」ではなく「短時間粘った後の throw」に変えるだけ。
//   renameSyncWithRetry はエクスポートされており、ワーカーログ圧縮
//   （strip-thinking-token-lines.js の compactWorkerLog）も同じ rename リトライを
//   再利用する（Issue #258）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');

// rename のリトライ対象エラーコード（graceful-fs の polyfills.js と同一）
const RENAME_RETRYABLE_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);
// リトライ合計予算（ms）。graceful-fs の 60 秒を常駐プロセス向けに短縮。
const RENAME_RETRY_BUDGET_MS = 500;
// バックオフ: 初期0ms・10ms刻み・最大100ms で頭打ち（graceful-fs と同じ値）
const RENAME_RETRY_INITIAL_BACKOFF_MS = 0;
const RENAME_RETRY_BACKOFF_STEP_MS = 10;
const RENAME_RETRY_MAX_BACKOFF_MS = 100;

// 同期sleep用の共有バッファ（Atomics.wait は SharedArrayBuffer 上の値待ちのみ可）。
// worker-supervisor.js の _sleep と同型。
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(sleepBuffer, 0, 0, ms);
}

/**
 * rename を EACCES/EPERM/EBUSY の間だけ短時間リトライする。
 * バックオフは graceful-fs の polyfills.js（0→10ms刻み→最大100ms）に合わせる。
 *
 * リトライ可否は staging の存在で判定する（graceful-fs は対象の消失=fs.stat ENOENT で
 * 判定するが、上書き対象は常に存在するため本関数では staging の有無を使う）。
 * - staging が消えている → rename は実際に成功済み（エラーは誤検出）。成功扱いで返す。
 * - staging が残っている → rename は未完了。残り予算の範囲でリトライする。
 *
 * @param {string} stagingPath
 * @param {string} filePath
 * @throws {Error} 予算を使い切っても rename が成功しない場合
 */
function renameSyncWithRetry(stagingPath, filePath) {
  const start = Date.now();
  let backoff = RENAME_RETRY_INITIAL_BACKOFF_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      fs.renameSync(stagingPath, filePath);
      return;
    } catch (e) {
      const retryable = e && RENAME_RETRYABLE_CODES.has(e.code);
      // 成功済みなら（rename は原子的なので staging が消えていれば rename は完了）。
      // 予算境界でも staging 消失＝成功を優先して誤検出で throw しない。
      if (retryable && !fs.existsSync(stagingPath)) return;
      const withinBudget = Date.now() - start < RENAME_RETRY_BUDGET_MS;
      if (!retryable || !withinBudget) throw e;
      sleepSync(backoff);
      if (backoff < RENAME_RETRY_MAX_BACKOFF_MS) {
        backoff += RENAME_RETRY_BACKOFF_STEP_MS;
      }
    }
  }
}

/**
 * オブジェクトを JSON として原子的に書き出す（staging → rename）。
 *
 * @param {string} filePath 出力先ファイルパス
 * @param {object} data     書き出すオブジェクト（JSON.stringify(data, null, 2)）
 * @returns {string} 出力先ファイルパス
 * @throws {Error} 親ディレクトリ作成・一時ファイル書込み・rename のいずれかが失敗した場合
 */
/*
 * ここで書く JSON は状態の記録であり、プロセス間の連絡手段ではない。
 * 書き手は常に1つに保つこと。子プロセスが親の書いた記録を読んで自分の値を
 * 書き足す形にすると、読み込みと書き戻しの間に順序が生まれて競合する。
 *
 * 理由と経緯: docs/adr/0032-json-state-files-have-a-single-writer.md
 */
function atomicWriteJson(filePath, data) {
  return atomicWriteText(filePath, JSON.stringify(data, null, 2));
}

function temporaryPath(filePath, prefix) {
  const dir = path.dirname(filePath);
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `.${prefix}-${path.basename(filePath)}.${process.pid}-${Date.now()}-${rand}`);
}

function stageText(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const stagingPath = temporaryPath(filePath, 'staging');
  try {
    fs.writeFileSync(stagingPath, content, 'utf8');
  } catch (error) {
    try { fs.unlinkSync(stagingPath); } catch {}
    throw error;
  }
  return stagingPath;
}

function statIfExists(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function normalizeTextWrite(entry) {
  if (!entry || typeof entry.filePath !== 'string' || entry.filePath.length === 0) {
    throw new TypeError('atomicWriteTextPairのfilePathは空でない文字列で指定してください');
  }
  if (typeof entry.content !== 'string') {
    throw new TypeError('atomicWriteTextPairのcontentは文字列で指定してください');
  }
  if (entry.expectedContent !== undefined && typeof entry.expectedContent !== 'string') {
    throw new TypeError('atomicWriteTextPairのexpectedContentは文字列で指定してください');
  }
  return {
    filePath: path.resolve(entry.filePath),
    content: entry.content,
    overwrite: entry.overwrite !== false,
    expectedContent: entry.expectedContent,
    stagingPath: null,
    backupPath: null,
    installed: false,
  };
}

function rollbackTextWrites(records) {
  const rollbackErrors = [];

  for (const record of records.slice().reverse()) {
    if (!record.installed) continue;
    try {
      unlinkIfExists(record.filePath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }

  for (const record of records.slice().reverse()) {
    if (!record.backupPath) continue;
    try {
      if (statIfExists(record.filePath)) unlinkIfExists(record.filePath);
      renameSyncWithRetry(record.backupPath, record.filePath);
      record.backupPath = null;
    } catch (error) {
      rollbackErrors.push(error);
    }
  }

  for (const record of records) {
    try {
      if (record.stagingPath) unlinkIfExists(record.stagingPath);
      if (record.backupPath) unlinkIfExists(record.backupPath);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  return rollbackErrors;
}

/**
 * 複数のテキストファイルを一つの更新として書き出す。
 *
 * 2ファイルのrename自体をOSが一度に原子化することはできないため、全ファイルを
 * stagingしてから既存ファイルを退避し、配置途中の失敗では逆順にロールバックする。
 * 単一ファイルのatomicWriteTextと同じstagingとrenameSyncWithRetryを使い、呼び出し側
 * に片方だけを書き込む経路を作らない。
 *
 * @param {Array<{filePath: string, content: string, overwrite?: boolean, expectedContent?: string}>} entries 2件の書込み
 * @returns {string[]} 書き込んだファイルパス
 * @throws {Error} staging、配置、またはロールバックに失敗した場合
 */
function atomicWriteTextTransaction(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('atomicWriteTextには1件以上の書込みを指定してください');
  }
  const records = entries.map(normalizeTextWrite);
  const targets = new Set();
  for (const record of records) {
    if (targets.has(record.filePath)) {
      throw new TypeError(`atomicWriteTextPairの出力先が重複しています: ${record.filePath}`);
    }
    targets.add(record.filePath);
    const current = statIfExists(record.filePath);
    if (current && !current.isFile()) {
      const error = new Error(`atomicWriteTextPairの出力先が通常ファイルではありません: ${record.filePath}`);
      error.code = 'EISDIR';
      throw error;
    }
    if (!record.overwrite && current) {
      const error = new Error(`atomicWriteTextPairの作成先が既に存在します: ${record.filePath}`);
      error.code = 'EEXIST';
      throw error;
    }
    if (record.expectedContent !== undefined) {
      if (!current) {
        const error = new Error(`atomicWriteTextPairの期待した既存ファイルがありません: ${record.filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      const actual = fs.readFileSync(record.filePath, 'utf8');
      if (actual !== record.expectedContent) {
        const error = new Error(`atomicWriteTextPairの入力が検証後に変更されています: ${record.filePath}`);
        error.code = 'ESTALE';
        throw error;
      }
    }
  }

  try {
    for (const record of records) record.stagingPath = stageText(record.filePath, record.content);

    for (const record of records) {
      const current = statIfExists(record.filePath);
      if (current && !current.isFile()) {
        const error = new Error(`atomicWriteTextPairの出力先が通常ファイルではありません: ${record.filePath}`);
        error.code = 'EISDIR';
        throw error;
      }
      if (!record.overwrite && current) {
        const error = new Error(`atomicWriteTextPairの作成先が既に存在します: ${record.filePath}`);
        error.code = 'EEXIST';
        throw error;
      }
      if (!current) {
        if (record.expectedContent !== undefined) {
          const error = new Error(`atomicWriteTextPairの期待した既存ファイルがありません: ${record.filePath}`);
          error.code = 'ENOENT';
          throw error;
        }
        continue;
      }

      const backupPath = temporaryPath(record.filePath, 'backup');
      renameSyncWithRetry(record.filePath, backupPath);
      record.backupPath = backupPath;
      if (record.expectedContent !== undefined) {
        const actual = fs.readFileSync(record.backupPath, 'utf8');
        if (actual !== record.expectedContent) {
          const error = new Error(`atomicWriteTextPairの入力が検証後に変更されています: ${record.filePath}`);
          error.code = 'ESTALE';
          throw error;
        }
      }
    }

    for (const record of records) {
      if (!record.overwrite && statIfExists(record.filePath)) {
        const error = new Error(`atomicWriteTextPairの作成先が既に存在します: ${record.filePath}`);
        error.code = 'EEXIST';
        throw error;
      }
      renameSyncWithRetry(record.stagingPath, record.filePath);
      record.stagingPath = null;
      record.installed = true;
    }
  } catch (error) {
    const rollbackErrors = rollbackTextWrites(records);
    if (rollbackErrors.length > 0) error.rollbackErrors = rollbackErrors;
    throw error;
  }

  for (const record of records) {
    if (record.backupPath) {
      // 配置は完了しているため、退避ファイルの掃除失敗で更新結果を巻き戻さない。
      // 単一ファイル版のstaging掃除と同じく、残骸は次の手動調査で確認できる。
      try { fs.unlinkSync(record.backupPath); } catch (error) {
        if (!error || error.code !== 'ENOENT') process.emitWarning(error);
      }
    }
  }
  return records.map((record) => record.filePath);
}

/**
 * UTF-8テキストを原子的に書き出す。失敗時は staging を必ず掃除する。
 * @param {string} filePath
 * @param {string} content
 * @returns {string}
 */
function atomicWriteTextPair(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) {
    throw new TypeError('atomicWriteTextPairには2件の書込みを指定してください');
  }
  return atomicWriteTextTransaction(entries);
}

function atomicWriteText(filePath, content) {
  const stagingPath = stageText(filePath, content);
  try {
    renameSyncWithRetry(stagingPath, filePath);
  } catch (error) {
    // 失敗時は staging を掃除（ベストエフォート）して失敗を伝える
    try { fs.unlinkSync(stagingPath); } catch {}
    throw error;
  }
  return filePath;
}

module.exports = { atomicWriteJson, atomicWriteText, atomicWriteTextPair, renameSyncWithRetry };
