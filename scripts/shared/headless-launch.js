'use strict';
// headless-launch.js — ワーカーを画面を使わずにバックグラウンド起動する共通ロジック
//
// pane-launch.js（WezTermペイン起動）の後継。ワーカーは全て非対話1回実行であり、
// 画面表示は動作に不要である一方、動作記録は必須である。そこで標準出力/標準エラーを
// **ファイル記述子として直接リダイレクト**し、実行中から逐次ログファイルへ書き込む。
//
// パイプ（Tee-Object / tee）は一切使わない。パイプ経由の複製はエージェントの非対話
// execモードと非互換で、本番でexit 1即クラッシュを起こした実績がある（Issue #150）。
// fd リダイレクトはシェルの文字列パイプライン層を通らないため、この障害も
// マルチバイト文字の文字化けも構造的に起こらない（日本語Windowsで実機確認済み）。
//
// 起動は detached な中継プロセス（headless-shim.js）を1段挟む。その理由はシム側の
// ファイル冒頭に記載（Windowsのdetachedではpwshが起動しないという実機制約）。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('../child-process');
const { buildLoginShellExecArgs } = require('../agent-exec');
const { getProcessStartTime } = require('../process-lifecycle');
const { ARTIFACTS, legacyWorkerLogPath, recordPath } = require('./record-paths');

const SHIM_PATH = path.join(__dirname, 'headless-shim.js');

// headless実行の出力先はログファイルであり端末ではない。ANSIカラーコードは可読性を下げ、
// resume応答の代理送信でGitHubへ転記されたときには制御文字がそのまま本文に混ざる。
// NO_COLOR（https://no-color.org/）は多くのCLIが尊重する事実上の標準で、
// 対応しないCLIは単に無視するため、全ワーカー共通で設定して差し支えない。
//
// 実機検証（2026-07-25、ログの生バイトでESC数を計測）:
//   codex / claude / agy … ESC 0。非TTYを検出して自前で無色化している
//   reasonix          … ESC あり。NO_COLOR=1 でも TERM=dumb でも非TTYでも消えない
//                        （thinking表示にはカラー判定を適用しない意図的な設計。v1.17.20で確認）
// reasonix 側は `--show-thinking` を外すことで実害を潰した（agent-defaults.json）。
// この設定は残りのCLI・将来追加されるCLIに対して「正しい信号を出しておく」ためのもの。
const HEADLESS_ENV = Object.freeze({ NO_COLOR: '1' });

// テスト中に実ワーカー（エージェントCLI）を起動してしまう事故を構造的に防ぐガード。
// .claude/rules/test-process-spawn-safety.md が求める「実spawnをenvフラグでゲートする」の
// 実装であり、ここが最後の砦になる。
//
// 実障害: 引数バリデーションを検証するだけのテストが、ガードの無い状態では worktree 作成と
// エージェント起動まで到達し、実際に claude.exe が4本起動してトークンを消費した
// （WEZTERM_PANE 必須チェックが偶然の安全弁になっており、headless化で失われたため）。
//
// NODE_TEST_CONTEXT は node --test がテストファイルへ自動的に設定し、そこから spawn された
// 子プロセスにも継承される。テスト側の設定漏れに依存せず効くため、これを主たる判定に使う。
// GH_MAESTRO_DISABLE_REAL_SPAWN は、別のテストランナーや手動確認で明示的に抑止したい場合の口。
const REAL_SPAWN_DISABLED_ENV = 'GH_MAESTRO_DISABLE_REAL_SPAWN';

function realSpawnDisabledReason() {
  if (process.env.NODE_TEST_CONTEXT) return 'テスト実行中（NODE_TEST_CONTEXT が設定されています）';
  if (process.env[REAL_SPAWN_DISABLED_ENV]) return `${REAL_SPAWN_DISABLED_ENV} が設定されています`;
  return null;
}

// テストで注入可能にする（実プロセスを spawn しない。test-process-spawn-safety ルール準拠）。
let _spawn = spawn;
let _getProcessStartTime = getProcessStartTime;

/**
 * ワーカーのログファイルパスを返す。
 *
 * 1ワーカー1ファイルに固定し、新規起動もresumeも同じファイルへ追記する
 * （時系列が1本に繋がり、後から一貫した方法で追跡できる）。
 *
 * @param {string} workspace
 * @param {string} workerName
 * @param {{ownerKind:string, ownerId:string|number, workerName?:string}} [owner]
 * @returns {string}
 */
function workerLogPath(workspace, workerName, owner = null) {
  if (owner) {
    return recordPath(workspace, {
      ...owner,
      workerName: owner.workerName || workerName,
      artifact: ARTIFACTS.WORKER_LOG,
    });
  }
  return legacyWorkerLogPath(workspace, workerName);
}

/**
 * argv を headless（画面なし）で起動し、標準出力/標準エラーを logPath へ直接リダイレクトする。
 *
 * 起動したプロセスは detach され、呼び出し元（使い捨てのCLIプロセス）が終了しても生き続ける。
 * 呼び出し元は返り値の pid/startTime を workers.json に記録し、以降の生存確認に使う。
 *
 * 返る pid は中継プロセス（headless-shim.js）のもの。シムは子（ログインシェル→エージェント）の
 * 終了コードでそのまま終了するため、**シムの生死 = ワーカーの生死** であり、生存確認にそのまま
 * 使える。終了させる場合はプロセスツリー全体を落とすこと（kill-tree.js::killProcessTree）。
 *
 * @param {object} params
 * @param {string[]} params.argv       - エージェントコマンド + 全引数
 * @param {string} params.cwd          - 作業ディレクトリ（worktree）
 * @param {string} params.logPath      - 標準出力/標準エラーの書き込み先（追記。親ディレクトリは自動作成）
 * @param {object} [params.env={}]     - 起動プロセスに注入する環境変数
 * @param {object|null} [params.onExit=null] - 子終了後にshimがログfd閉鎖後に実行する終了フック
 * @returns {{ pid: number, startTime: string|null, logPath: string }}
 * @throws {Error} ログを準備できない場合、または spawn に失敗した場合
 */
function launchAgentHeadless({ argv, cwd, logPath, env = {}, onExit = null }) {
  // spawn が注入済み（テストが明示的に差し替えた）なら実プロセスは起きないので通す。
  const disabledReason = _spawn === spawn ? realSpawnDisabledReason() : null;
  if (disabledReason) {
    throw new Error(
      `実ワーカーを起動しません: ${disabledReason}。` +
      `起動経路をテストから検証する場合は _setSpawn で spawn を注入してください。`
    );
  }

  // headless共通の環境変数を土台に、呼び出し元指定を上書きとして重ねる
  // （呼び出し元が明示的に指定した値が勝つ）。
  const launchEnv = { ...HEADLESS_ENV, ...env };

  // ログインシェル経由のラップは維持する。$PROFILE の pwsh 関数として定義された
  // エージェント（claude-ds 等）は、これを通さないと解決できない（agent-exec.js 参照）。
  // 終了フックはログfdを保持するシェル内で実行せず、shimが子終了後に起動する。
  const shellArgs = buildLoginShellExecArgs(argv, process.platform, null, launchEnv);

  // ログの準備に失敗したらプロセスを起動しない。記録の残らないワーカーを走らせると、
  // 本Issueが解消しようとしている「後から追跡できない実行」がそのまま再発する。
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // 実際に書けることをここで確認しておく（シムは標準出力を持たないため、
    // シム内で初めて失敗すると原因が一切残らない）。
    fs.closeSync(fs.openSync(logPath, 'a'));
  } catch (e) {
    throw new Error(`ログファイルを開けません: ${logPath} — ${e.message}`);
  }

  let child;
  try {
    const shimArgs = [SHIM_PATH, JSON.stringify(shellArgs), logPath];
    if (onExit) shimArgs.push(JSON.stringify(onExit));
    child = _spawn(process.execPath, shimArgs, {
      cwd,
      env: { ...process.env, ...launchEnv },
      // 起動元の使い捨てCLIが終了してもワーカーを生かすために detached が要る。
      // node は detached でも正常に動く（pwsh は動かない。だからシムを挟んでいる）。
      detached: true,
      windowsHide: true,
      // シム自身の標準入出力は使わない。ログへの書き込みはシムが開くfdが担う。
      // ワーカーへのstdin EOFはシムが child.stdin.end() で送るため（Issue #244）、
      // シム自身のstdin は 'ignore' のままでよい（シムはstdinを読まない）。
      stdio: 'ignore',
    });
  } catch (e) {
    throw new Error(`エージェントプロセスの起動に失敗しました: ${e.message}`);
  }

  // 'error' リスナーが未登録のまま EventEmitter が 'error' を発火すると、Node は例外を
  // 送出して**呼び出し元プロセスごと落とす**。ここは非同期 spawn なので、返り値を返した後に
  // 発火しうる（リソース枯渇時など）。起動元は既に次の処理へ進んでいて例外を受け取れないため、
  // ログへ書き残すことが唯一の追跡手段になる。
  child.on('error', (e) => {
    try {
      fs.appendFileSync(logPath, `\n[gh-maestro] ワーカープロセスの起動でエラーが発生しました: ${e.message}\n`);
    } catch { /* ログにも書けない場合は諦める（ここで再throwすると同じ事故になる） */ }
  });

  if (!child.pid) {
    throw new Error('エージェントプロセスのPIDを取得できませんでした');
  }

  // 呼び出し元（使い捨てCLI）の終了を子がブロックしないよう切り離す。
  child.unref();

  // PID再利用による生存判定の誤りを防ぐため、起動時刻も併せて返す
  // （process-lifecycle.js の verifyProcessIdentity で照合する）。
  return { pid: child.pid, startTime: _getProcessStartTime(child.pid), logPath };
}

module.exports = {
  launchAgentHeadless,
  workerLogPath,
  SHIM_PATH,
  REAL_SPAWN_DISABLED_ENV,
  _setSpawn: (fn) => { _spawn = fn; },
  _setGetProcessStartTime: (fn) => { _getProcessStartTime = fn; },
};
