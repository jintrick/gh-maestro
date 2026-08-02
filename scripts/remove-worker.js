#!/usr/bin/env node
// remove-worker.js
// ワーカープロセスをkillし、worktreeを即座に削除し、workers.jsonからエントリを削除する。
// ディレクトリ実体がロックで残っても（kill直後のハンドル未解放。Windowsでは正常）
// 次回reset-session.jsがjunction非追跡で安全に掃除する。残骸を手動rmしないこと。
//
// Usage:
//   node remove-worker.js \
//     --worker-name <name> \
//     --workspace <path>

const { spawnSync, execSync } = require('./child-process');
const { resolve } = require('path');
const { readFileSync, writeFileSync, existsSync, rmSync } = require('fs');
const { unlinkJunctions } = require('./unlink-junctions');
const { normalizeWorkerEntry } = require('./worker-entry');
const { worktreeRemove, worktreePrune } = require('./git-worktree');
const { killProcessTree } = require('./kill-tree');
const { sweepRegistry } = require('./process-lifecycle');
const { parseFlags, hasHelpFlag, resolveWorkspace } = require('./shared/workspace');
const { resolveWorkerName } = require('./shared/workers-registry');

const USAGE = `remove-worker.js — ワーカープロセスを kill し worktree を削除する

Usage: node remove-worker.js --worker-name <name> [--workspace <path>]
       node remove-worker.js --issue <N> --skill <role> [--workspace <path>]

Options:
  --worker-name <name>  削除するワーカー名。--issue+--skill と併用不可。
  --issue <N>           削除対象ワーカーを workerName ではなく〈Issue番号 + 役割〉で指定する場合のIssue番号。
  --skill <role>        同上の役割（gh-maestro-coder等）。workers.json から一意に解決する。
                        該当が複数ある場合は候補を表示してエラー終了するので --worker-name で明示する。
  --workspace <path>    ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または
                        CWDからの .gh-maestro/ 上方探索で解決）

--worker-name か〈--issue + --skill〉のいずれかで削除対象を指定する。
ワーカープロセスツリーを kill し、worktree と同名ブランチを削除し、workers.json からエントリを除く。
移行前セッションが残した WezTerm ペイン（レガシー paneId）があればそれも kill する。
ディレクトリがロックで残っても次回 reset-session.js が junction 非追跡で安全に掃除する
（残骸を手動 rm しないこと。node_modules junction を辿って共有ファイルを壊す）。`;

if (require.main === module) {
  const argv = process.argv.slice(2);
  const { values, rest, exitFlagMiss } = parseFlags(argv, ['--worker-name', '--workspace', '--issue', '--skill']);

  // exitFlagMiss（値欠落）を先に判定する。未消費の値トークンが rest に残るため、
  // それがたまたま "--help" と一致すると後段の hasHelpFlag が誤検出しうる。
  // 値欠落は常にエラー優先（フェイルクローズ）とする。
  if (exitFlagMiss) {
    console.error(USAGE);
    process.exit(1);
  }

  if (hasHelpFlag(rest)) {
    console.log(USAGE);
    process.exit(0);
  }

  // このスクリプトは位置引数を取らない。余剰な位置引数・未知フラグは黙って無視しない
  // （spawn-worker.js / create-issue.js と同じ rest 検証パターン。argv-parsing-pitfalls参照）。
  if (rest.length > 0) {
    console.error(`remove-worker: 未知の引数です: ${rest.join(' ')}`);
    console.error(USAGE);
    process.exit(1);
  }

  const fail = (msg) => { console.error(`remove-worker: ${msg}`); process.exit(1); };

  // 他スクリプト（poll-pr.js等）と同じ workspace 解決順（GH_MAESTRO_WORKSPACE env >
  // --workspace > CWD探索）に統一する。素の process.cwd() フォールバックだと、CWD が
  // ホームディレクトリ配下等に誤解決される余地が残るため使わない（Issue #214）。
  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) fail('ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');

  // 削除対象の解決: --worker-name（明示）優先。無ければ〈--issue + --skill〉から逆引きする。
  let workerName = values['--worker-name'];
  if (workerName && (values['--issue'] || values['--skill'])) {
    fail('--worker-name と〈--issue + --skill〉は併用できません。どちらか一方で指定してください。');
  }
  if (!workerName) {
    if (!values['--issue'] || !values['--skill']) {
      console.error(USAGE);
      process.exit(1);
    }
    try {
      workerName = resolveWorkerName(workspace, { issue: values['--issue'], skill: values['--skill'] });
    } catch (e) {
      fail(e.message);
    }
  }

  const workersJson  = resolve(workspace, '.gh-maestro', 'workers.json');
  const worktreeDir  = resolve(workspace, '.gh-maestro', 'worktrees', workerName);
  const IS_WIN       = process.platform === 'win32';

  if (!existsSync(workersJson)) fail(`workers.json が見つかりません: ${workersJson}`);

  let workers;
  try {
    workers = JSON.parse(readFileSync(workersJson, 'utf8'));
  } catch (e) {
    fail(`workers.json のパースに失敗しました: ${e.message}`);
  }

  // ── ワーカープロセスを終了 ─────────────────────────────────────────────

  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const workerEntry = normalizeWorkerEntry(workers[workerName]);

  // ── 後方互換: レガシーな detached notifier（poll-and-notify.js）を kill ──────
  // 過去のセッションの workers.json には notifierPid が残っている可能性がある。
  // 現在の spawn では notifier は起動されないが、移行過渡期の後方互換として残す。
  if (workerEntry.notifierPid) {
    killProcessTree(workerEntry.notifierPid);
    console.warn(`remove-worker: レガシー notifier (pid ${workerEntry.notifierPid}) を終了しました`);
  }

  // headless ワーカーのプロセスツリーを終了する。登録PIDは中継シム（headless-shim.js）の
  // ものであり、その配下にログインシェルとエージェント本体がぶら下がるため、
  // 単体killではなくツリー全体を落とす必要がある。
  if (workerEntry.pid) {
    killProcessTree(workerEntry.pid);
    console.warn(`remove-worker: ワーカープロセス (pid ${workerEntry.pid}) を終了しました`);
    // プロセスがハンドルを解放するまで少し待つ（worktree削除がロックで失敗するのを減らす）
    sleep(500);
  }

  // ── 後方互換: 移行前セッションが残した WezTerm ペインを kill ──────────────
  // Issue #151 以前に起動されたワーカーのエントリには paneId が残っている。
  // 起動経路が headless に変わってもこの掃除は必要である（起動元コードを消したから
  // kill ロジックも不要、という判断は過去2回手戻りを起こしている。
  // .claude/rules/legacy-process-cleanup-safety.md 参照）。
  if (workerEntry.paneId) {
    const killResult = spawnSync('wezterm', ['cli', '--no-auto-start', 'kill-pane', '--pane-id', workerEntry.paneId], { encoding: 'utf8' });
    if (killResult.status !== 0) {
      console.warn(`remove-worker: レガシーpane ${workerEntry.paneId} のkill-pane 失敗: ${(killResult.stderr || '').trim()}`);
    } else {
      console.warn(`remove-worker: レガシーpane ${workerEntry.paneId} を終了しました`);
    }
    sleep(500);
  }

  if (!workerEntry.pid && !workerEntry.paneId) {
    console.warn(`remove-worker: ワーカー "${workerName}" に終了対象のプロセスが記録されていません — worktree削除のみ実行します`);
  }

  // ── PID registry sweep: ワーカーの登録PIDを同一性確認の上で kill ─────
  // req.9: workerName に紐づく登録PIDを発見し、同一性確認後にkillする
  {
    const sweepResults = sweepRegistry(workspace, {
      match: (entry) => entry.workerName === workerName,
    });
    if (sweepResults.killed.length > 0) {
      console.warn(`remove-worker: PID registry: ${sweepResults.killed.length} 件のプロセスを終了しました`);
      for (const k of sweepResults.killed) {
        console.warn(`remove-worker:   pid=${k.pid} script=${k.script || '-'}`);
      }
    }
    if (sweepResults.cleaned.length > 0) {
      console.warn(`remove-worker: PID registry: ${sweepResults.cleaned.length} 件のstaleエントリを掃除しました`);
    }
    for (const e of sweepResults.errors) {
      console.warn(`remove-worker: PID registry error: ${e}`);
    }
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

  // ── workers.jsonから削除 ──────────────────────────────────────────────

  delete workers[workerName];
  writeFileSync(workersJson, JSON.stringify(workers, null, 2), 'utf8');
}
