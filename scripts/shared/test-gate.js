'use strict';
// scripts/shared/test-gate.js
// Issue #209: `npm test` の実結果（spec レポーターの集計行 `# fail N`）を読み、テスト失敗を機械的に
// 検出する共有ヘルパー。gh-create-pr.js（PR作成時ゲート）で使用する。
//
// 設計上の理由:
// - 「テストが通っていなければマージしない」をエージェントの判断・注意力に依存させないため、
//   決定的コードが `npm test` の実出力を読んで判定する。`# fail` 行が読めない・実行自体が失敗した
//   場合は「安全と確認できない」として失敗扱いにする（フェイルクローズ。
//   .claude/rules/fail-closed-safety-guards.md）。
// - npm 経由のテスト実行は git フックでなくスクリプト内の子プロセス spawn で行う。git がフック環境へ
//   注入する GIT_DIR 等がテストへ漏れ、cwd を無視して実リポジトリを操作する経路（Issue #283）を避ける。
//   それでも spawn 前に GIT_* を除去し、cwd 基準のリポジトリ発見を保証する（child-process.js の
//   stripGitEnv を再利用）。

const { spawnSync, stripGitEnv } = require('../child-process');

// Windows では npm は npm.cmd（cmd 経由）で起動する。Node の spawnSync は .cmd を shell 経由で
// 起動する必要があるため、platform に応じて shell:true を付与する。posix は npm を直接起動する。
function buildTestCommand() {
  if (process.platform === 'win32') {
    return { cmd: 'npm.cmd', args: ['test'], opts: { shell: true } };
  }
  return { cmd: 'npm', args: ['test'], opts: {} };
}

/**
 * `npm test` を実行し、spec レポーターの集計行から `# fail N` を読み取る。
 *
 * 戻り値の `fail` は集計行の値。集計行が読めなかった場合は `null`（フェイルクローズ判定は呼び出し側）。
 * 判定ロジックを共有ヘルパーに持たせないのは、呼び出し側（CLI のエラーメッセージ組み立て等）で
 * 扱いが異なるため。`fail !== 0`（または `status !== 0` / `fail === null`）は全て「テストが通っていない」。
 *
 * @param {object} [opts]
 * @param {string} [opts.cwd]  テストを実行するリポジトリディレクトリ（省略時 process.cwd()）。
 * @param {object} [opts.env]  環境変数（省略時 process.env）。GIT_* は常に除去して spawn する。
 * @returns {{ status: number, fail: number|null, output: string }}
 *   status - npm test の終了コード。 fail - `# fail N` の N（読めなければ null）。 output - stdout+stderr 結合。
 */
function runTestSuite(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const env = stripGitEnv({ env: opts.env });
  const { cmd, args, opts: cmdOpts } = buildTestCommand();
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', ...cmdOpts });
  const output = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  const m = output.match(/^# fail\s+(\d+)\s*$/m);
  const fail = m ? parseInt(m[1], 10) : null;
  return { status: r.status, fail, output };
}

module.exports = { runTestSuite };
