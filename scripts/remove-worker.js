#!/usr/bin/env node
// remove-worker.js
// ワーカープロセスを同一性確認の上でkillし、worktreeを即座に削除し、workers.jsonからエントリを削除する。
// ディレクトリ実体がロックで残っても（kill直後のハンドル未解放。Windowsでは正常）
// 次回reset-session.jsがjunction非追跡で安全に掃除する。残骸を手動rmしないこと。
//
// Usage:
//   node remove-worker.js <workerName> \
//     --workspace <path>

const { spawnSync, execSync } = require('./shared/child-process');
const { resolve } = require('path');
const { readFileSync, existsSync, rmSync } = require('fs');
const { unlinkJunctions } = require('./shared/unlink-junctions');
const { worktreeRemove, worktreePrune } = require('./shared/git-worktree');
const { atomicWriteJson } = require('./shared/atomic-write');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { resolveWorkerName } = require('./shared/workers-registry');
const { ARTIFACTS, legacyWorkerOwner, recordPath } = require('./shared/record-paths');
const { stopWorkerProcess } = require('./shared/stop-worker-process');

const USAGE = `remove-worker.js — ワーカープロセスを kill し worktree を削除する

Usage: node remove-worker.js <workerName> [--workspace <path>]
       node remove-worker.js --issue <N> --skill <role> [--workspace <path>]

Arguments:
  <workerName>           削除するワーカー名。--issue+--skill と併用不可。

Options:
  --issue <N>           削除対象ワーカーを workerName ではなく〈Issue番号 + 役割〉で指定する場合のIssue番号。
  --skill <role>        同上の役割（gh-maestro-coder等）。workers.json から一意に解決する。
                        該当が複数ある場合は候補を表示してエラー終了するので workerName（位置引数）で明示する。
  --workspace <path>    ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または
                        CWDからの .gh-maestro/ 上方探索で解決）

workerName（位置引数）か〈--issue + --skill〉のいずれかで削除対象を指定する。
対象プロセスの同一性を確認したうえでプロセスツリーを kill し（PID再利用時は kill をスキップ）、
worktree と同名ブランチを削除し、workers.json からエントリを除く。
移行前セッションが残した WezTerm ペイン（レガシー paneId）があればそれも kill する。
ディレクトリがロックで残っても次回 reset-session.js が junction 非追跡で安全に掃除する
（残骸を手動 rm しないこと。node_modules junction を辿って共有ファイルを壊す）。`;

function main(argv = process.argv.slice(2)) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--workspace': {}, '--issue': {}, '--skill': {} },
      booleans: ['--help', '-h'],
      // ワーカー名を1つだけ位置引数で受け取る。余剰な位置引数・未知フラグはパーサ側で拒否される
      // （spawn-worker.js / create-issue.js と同じ rest 検証パターン。argv-parsing-pitfalls参照）。
      positionals: { min: 0, max: 1 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      return 0;
    }
    for (const e of err.errors) console.error(`remove-worker: ${e.message}`);
    console.error(USAGE);
    return 1;
  }

  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    return 0;
  }

  const fail = (msg) => { console.error(`remove-worker: ${msg}`); return 1; };

  // 他スクリプト（poll-pr.js等）と同じ workspace 解決順（--workspace >
  // GH_MAESTRO_WORKSPACE env > CWD探索）に統一する。素の process.cwd() フォールバックだと、CWD が
  // ホームディレクトリ配下等に誤解決される余地が残るため使わない（Issue #214）。
  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) return fail('ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');

  // 削除対象の解決: workerName（位置引数）を優先。無ければ〈--issue + --skill〉から逆引きする。
  let workerName = rest[0];
  if (workerName && (values['--issue'] || values['--skill'])) {
    return fail('workerName（位置引数）と〈--issue + --skill〉は併用できません。どちらか一方で指定してください。');
  }
  if (!workerName) {
    if (!values['--issue'] || !values['--skill']) {
      console.error(USAGE);
      return 1;
    }
    try {
      workerName = resolveWorkerName(workspace, { issue: values['--issue'], skill: values['--skill'] });
    } catch (e) {
      return fail(e.message);
    }
  }

  const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
  const worktreeDir  = resolve(workspace, '.gh-maestro', 'worktrees', workerName);
  const IS_WIN       = process.platform === 'win32';

  if (!existsSync(workersJson)) return fail(`workers.json が見つかりません: ${workersJson}`);

  let workers;
  try {
    workers = JSON.parse(readFileSync(workersJson, 'utf8'));
  } catch (e) {
    return fail(`workers.json のパースに失敗しました: ${e.message}`);
  }

  if (!workers || typeof workers !== 'object' || !(workerName in workers)) {
    return fail(`ワーカー "${workerName}" のエントリが workers.json に見つかりません`);
  }

  // ── ワーカープロセスを終了（同一性確認付き） ─────────────────────────────

  try {
    stopWorkerProcess(workspace, workerName, {
      isRemoveMode: true,
      logWarn: (msg) => console.warn(msg),
      _injectedWorkers: workers,
    });
  } catch (e) {
    console.warn(`remove-worker: プロセス終了処理で警告が発生しました: ${e.message}`);
  }

  // ── worktreeを即座に削除 ──────────────────────────────────────────────

  const psRemove = (dir) => {
    if (!IS_WIN) return false;
    const escaped = dir.replace(/'/g, "''");
    try {
      execSync(
        `powershell -NoProfile -Command "[System.IO.Directory]::Delete('${escaped}', $true)"`,
        { stdio: 'pipe', timeout: 15000 }
      );
      return !existsSync(dir);
    } catch (_) {
      return false;
    }
  };

  if (existsSync(worktreeDir)) {
    console.warn(`remove-worker: worktree "${workerName}" を削除します...`);

    unlinkJunctions(worktreeDir, (msg) => console.warn(`remove-worker: ${msg}`));

    // git worktree remove
    try {
      worktreeRemove(worktreeDir, workspace, { doubleForce: true });
    } catch (e) {
      console.warn(`remove-worker: git worktree remove 失敗: ${e.message.split('\n')[0]}`);
    }

    try {
      worktreePrune(workspace);
    } catch (e) {
      console.warn(`remove-worker: git worktree prune 失敗: ${e.message.split('\n')[0]}`);
    }

    // git branch -D（worktreeと同名のブランチを削除）
    try {
      execSync(`git branch -D "${workerName}"`, { cwd: workspace, stdio: 'pipe' });
    } catch (e) {
      console.warn(`remove-worker: git branch -D 失敗: ${e.message.split('\n')[0]}`);
    }

    if (existsSync(worktreeDir)) {
      if (IS_WIN) {
        psRemove(worktreeDir);
      } else {
        try {
          rmSync(worktreeDir, { recursive: true, force: true });
        } catch (e) {
          console.warn(`remove-worker: rmSync 失敗: ${e.message.split('\n')[0]}`);
        }
      }
    }

    if (existsSync(worktreeDir)) {
      console.warn(`remove-worker: worktree "${workerName}" のメタデータ・ブランチ・workers.json エントリは削除済み。ディレクトリ実体だけがロックで残りました（kill直後のハンドル未解放。Windowsでは正常な挙動で、失敗ではありません）。次回セッションの reset-session.js が junction 非追跡で安全に掃除します。`);
      console.warn(`remove-worker: [重要・orchestratorへ] この残骸ディレクトリを手動の rm / rm -rf で消さないこと。worktree 内の node_modules は共有ワークスペースへの junction であり、rm は junction を辿って共有ファイルを破壊します。放置して reset-session.js に任せてください。`);
    } else {
      console.warn(`remove-worker: worktree "${workerName}" を削除しました`);
    }
  } else {
    console.warn(`remove-worker: worktree "${workerName}" のディレクトリが存在しません — スキップします`);
  }

  // ── msg-state の削除 ────────────────────────────────────────────────────
  // GitHub コメントのポーリングカーソルを削除する（ベストエフォート、ENOENT は成功扱い）。
  {
    const msgStateFile = resolve(workspace, '.gh-maestro', 'msg-state', `${workerName}.json`);
    try {
      if (existsSync(msgStateFile)) {
        rmSync(msgStateFile);
        console.warn(`remove-worker: msg-state "${workerName}.json" を削除しました`);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`remove-worker: msg-state 削除に失敗しました（ワーカー削除は続行します）: ${e.message}`);
      }
    }
  }

  // ── inbox-supervisor カーソルの削除 ─────────────────────────────────────
  // ワーカー宛てメッセージの処理カーソルを削除する。ワーカーが消えた以上、この
  // カーソルは以後使われない（ベストエフォート、ENOENT は成功扱い。Issue #248 項目6）。
  {
    try {
      const cursorFile = recordPath(workspace, {
        ...legacyWorkerOwner(workerName), artifact: ARTIFACTS.CURSOR,
      });
      if (existsSync(cursorFile)) {
        rmSync(cursorFile);
        console.warn(`remove-worker: inbox-supervisor cursor "${workerName}.json" を削除しました`);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`remove-worker: inbox-supervisor cursor 削除に失敗しました（ワーカー削除は続行します）: ${e.message}`);
      }
    }
  }

  // ── workers.jsonから削除 ──────────────────────────────────────────────

  delete workers[workerName];
  // 並行書き込み競合でも破損JSONを作らないようアトミック書き込みに統一する
  // （Issue #248 項目11）。
  atomicWriteJson(workersJson, workers);

  return 0;
}

if (require.main === module) {
  const code = main();
  process.exit(code);
}

module.exports = { main, USAGE };
