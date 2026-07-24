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

const SHIM_PATH = path.join(__dirname, 'headless-shim.js');

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
 * @returns {string}
 */
function workerLogPath(workspace, workerName) {
  return path.join(workspace, '.gh-maestro', 'worker-logs', `${workerName}.log`);
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
 * @param {object|null} [params.onExit=null] - 終了フック（agent-exec.js の buildLoginShellExecArgs へ渡す）
 * @returns {{ pid: number, startTime: string|null, logPath: string }}
 * @throws {Error} ログを準備できない場合、または spawn に失敗した場合
 */
function launchAgentHeadless({ argv, cwd, logPath, env = {}, onExit = null }) {
  // ログインシェル経由のラップは維持する。$PROFILE の pwsh 関数として定義された
  // エージェント（claude-ds 等）は、これを通さないと解決できない（agent-exec.js 参照）。
  const shellArgs = buildLoginShellExecArgs(argv, process.platform, onExit, env);

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
    child = _spawn(process.execPath, [SHIM_PATH, JSON.stringify(shellArgs), logPath], {
      cwd,
      env: { ...process.env, ...env },
      // 起動元の使い捨てCLIが終了してもワーカーを生かすために detached が要る。
      // node は detached でも正常に動く（pwsh は動かない。だからシムを挟んでいる）。
      detached: true,
      windowsHide: true,
      // シム自身の標準入出力は使わない。ログへの書き込みはシムが開くfdが担う。
      stdio: 'ignore',
    });
  } catch (e) {
    throw new Error(`エージェントプロセスの起動に失敗しました: ${e.message}`);
  }

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
  _setSpawn: (fn) => { _spawn = fn; },
  _setGetProcessStartTime: (fn) => { _getProcessStartTime = fn; },
};
