'use strict';

// agent-exec.js
// エージェント起動をログインシェル経由に抽象化するモジュール。
//
// 問題: spawn-worker.js はエージェントコマンドを直接 wezterm に argv として渡すため、
//   PATH 上の実行ファイルしか起動できない。pwsh 関数やシェルエイリアス（例: claude-ds
//   が $PROFILE の関数として定義されている場合）は解決されず、起動できない。
//
// 解決: 全エージェントをログインシェル（プロファイルがロードされた状態）経由で起動する
//   単一の抽象に統一し、存在確認も同一経路で行う。
//
//    - Windows: pwsh -EncodedCommand（UTF-16LE base64）で全引数をエスケープなしで渡す
//    - Unix:    bash -lc 'exec "$0" "$@"' で argv をそのまま渡す
//
// 制約:
//   - シェルの再パースで引数（空白・改行・@ 等）が壊れない渡し方にすること
//   - config.json / agent-defaults.json の command カスタマイズと衝突しないこと

const { spawnSync } = require('./child-process');

/**
 * エージェント起動 argv をログインシェル経由にラップする。
 *
 * @param {string[]} agentCmdArgs - エージェントコマンド + 全引数の配列
 *   （buildAgentCommandArgs の戻り値。第1要素がコマンド/関数名）
 * @param {string}   [platform=process.platform] - 'win32' またはそれ以外
 * @param {object|null} [onExit=null]
 * @param {object}   [env={}]
 * @param {string|null} [captureLogPath=null] - 指定時、エージェントの標準出力/標準エラーを
 *   このパスにも複製保存する（teeに相当）。ペインの表示はそのまま生きた状態を維持しつつ、
 *   エージェント種別に依存せず出力を後から読めるようにする（resume応答の代理送信に使う）。
 * @returns {string[]} wezterm split-pane に渡す argv（ログインシェル経由）
 * @throws {Error} agentCmdArgs が空の場合
 */
function buildLoginShellExecArgs(agentCmdArgs, platform = process.platform, onExit = null, env = {}, captureLogPath = null) {
  if (!Array.isArray(agentCmdArgs) || agentCmdArgs.length === 0) {
    throw new Error('agentCmdArgs must be a non-empty array');
  }

  if (platform === 'win32') {
    return buildPwshExecArgs(agentCmdArgs, onExit, env, captureLogPath);
  }
  return buildBashLoginExecArgs(agentCmdArgs, onExit, env, captureLogPath);
}

/**
 * Unix: bash -lc 経由の argv を構築する。
 *
 * bash -lc 'exec "$0" "$@"' <command> <arg1> <arg2> ...
 *   - -l: ログインシェル（.bash_profile / .bashrc / .profile がロードされる）
 *   - -c: コマンド文字列を実行
 *   - 'exec "$0" "$@"': シェルをエージェントプロセスに置き換え
 *   - <command> が $0、<arg1> 以降が $1 $2 ... として渡される
 *
 * 各引数は個別の argv エントリとして渡されるため、シェルによる再パースは発生せず、
 * 空白・改行を含む引数も安全。bash が exec で自分を置き換えるため、エージェント終了後
 * 余計なプロセスは残らない。
 *
 * captureLogPath 指定時は、`exec > >(tee -a <path>) 2>&1;` を冒頭に追加し、以降の
 * 標準出力/標準エラーをファイルにも複製する。プロセス置換によるリダイレクト設定は
 * ファイルディスクリプタの継承を通じて、後続の `exec "$0" "$@"`（プロセス置き換え）後も
 * 維持される。
 */
function buildBashLoginExecArgs(agentCmdArgs, onExit = null, env = {}, captureLogPath = null) {
  // 環境変数を export でシェルスクリプト冒頭に注入する（キーは固定の内部定数、値はシングル
  // クォートでリテラル化）。ワーカー識別（GH_MAESTRO_WORKER 等）を「環境の事実」として渡すため。
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'; `)
    .join('');
  const capturePrefix = captureLogPath
    ? `exec > >(tee -a '${captureLogPath.replace(/'/g, "'\\''")}') 2>&1; `
    : '';
  if (!onExit) return ['bash', '-lc', `${envPrefix}${capturePrefix}exec "$0" "$@"`, ...agentCmdArgs];
  return ['bash', '-lc', `${envPrefix}${capturePrefix}hook=$0; script=$1; workspace=$2; execution=$3; shift ${onExit.args.length}; "$@"; code=$?; "$hook" "$script" "$workspace" "$execution" "$code"; exit "$code"`, onExit.command, ...onExit.args, ...agentCmdArgs];
}

/**
 * Windows: pwsh -EncodedCommand 経由の argv を構築する。
 *
 * PowerShell -EncodedCommand はコマンド文字列を UTF-16LE の base64 として受け取るため、
 * シェルによる再パースが一切発生しない。引数内の空白・改行・特殊文字もそのまま維持される。
 *
 * 構築する PowerShell コマンド:
 *   & '<command>' '<arg1>' '<arg2>' ...
 *   - 各引数をシングルクォート '...' で囲む（PowerShell verbatim 文字列リテラル）
 *   - シングルクォート内の ' は '' にエスケープ（PowerShell の規則）
 *   - シングルクォート文字列内では $ / " / 改行 はすべてリテラルとして扱われる
 *   - &（call operator）で関数/実行ファイルを呼び出す
 *   - -NoProfile を指定しないことで $PROFILE がロードされ、pwsh関数も解決可能
 *
 * captureLogPath 指定時は `2>&1 | Tee-Object -FilePath <path>` でネイティブコマンドの
 * 標準出力/標準エラーをファイルにも複製する。
 */
function buildPwshExecArgs(agentCmdArgs, onExit = null, env = {}, captureLogPath = null) {
  // 各引数を PowerShell のシングルクォートリテラルとしてエスケープ
  //   ' → '' （PowerShell の規則）
  //   全体を '...' で囲む（内部での 変数展開 $ / コマンド置換 / " はすべて無効化される）
  const escapedArgs = agentCmdArgs.map((arg) => {
    const escaped = arg.replace(/'/g, "''");
    return `'${escaped}'`;
  }).join(' ');

  // 環境変数を $env:KEY='VALUE' でコマンド冒頭に注入する（キーは固定の内部定数、値はシングル
  // クォートでリテラル化）。ワーカー識別（GH_MAESTRO_WORKER 等）を「環境の事実」として渡すため。
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `$env:${k}='${String(v).replace(/'/g, "''")}'; `)
    .join('');

  // captureLogPath指定時はパイプでTee-Objectへ流す（Start-Transcriptはネイティブプロセスの
  // 標準出力を確実には捕捉できないため不採用——実機検証で、ネストしたpwsh呼び出しの出力が
  // transcriptに記録されないことを確認済み）。ネイティブコマンドをパイプに含めても、
  // Tee-Objectはコマンドレットのため $LASTEXITCODE は書き換えられず、ネイティブコマンドの
  // 終了コードのまま保持される（実機検証済み）。
  //
  // [Console]::OutputEncoding を明示的にUTF-8にしてからパイプする。既定の
  // コンソール出力エンコーディングはシステムのANSI/OEMコードページ（日本語Windowsでは
  // Shift-JIS系）になっており、ネイティブプロセスのUTF-8出力をパイプ経由でテキスト化する際に
  // 文字化けする（実機検証で発覚: 日本語を含む出力がTee-Object経由で保存すると文字化けし、
  // パイプを使わない直接リダイレクトでは文字化けしなかった）。
  const captureSuffix = captureLogPath
    ? ` 2>&1 | Tee-Object -FilePath '${captureLogPath.replace(/'/g, "''")}'`
    : '';
  const capturePrefix = captureLogPath
    ? '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    : '';

  // & <command> <args...>
  // PowerShell の call operator & は関数・コマンドレット・実行ファイルのどれでも実行できる
  const exitHook = onExit
    ? `; $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }; & '${onExit.command.replace(/'/g, "''")}' ${onExit.args.map(arg => `'${arg.replace(/'/g, "''")}'`).join(' ')} $exitCode; exit $exitCode`
    : (captureLogPath ? `; $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }; exit $exitCode` : '');
  const command = `${envPrefix}${capturePrefix}& ${escapedArgs}${captureSuffix}${exitHook}`;

  // UTF-16LE base64 にエンコード（PowerShell -EncodedCommand の要求形式）
  const encoded = Buffer.from(command, 'utf16le').toString('base64');

  return ['pwsh', '-NoLogo', '-EncodedCommand', encoded];
}

/**
 * エージェントコマンドがログインシェルで解決可能か確認する。
 *
 * 実起動と同じ解決方法（ログインシェル経由）で存在確認を行うため、
 * 「実起動できるのに存在確認だけ落ちる」状態を防ぐ。
 * PATH 実行ファイル・pwsh 関数・シェルエイリアスのいずれでも一貫して判定できる。
 *
 * @param {string}   command  - 確認するコマンド/関数/エイリアス名
 * @param {string}   [platform=process.platform] - 'win32' またはそれ以外
 * @returns {boolean} ログインシェルで解決可能なら true
 */
function checkAgentExists(command, platform = process.platform) {
  if (typeof command !== 'string' || command.length === 0) {
    return false;
  }

  if (platform === 'win32') {
    return checkPwshExists(command);
  }
  return checkBashExists(command);
}

/**
 * Windows: pwsh の Get-Command で存在確認。
 * Get-Command は実行ファイル・関数・エイリアス・コマンドレットのすべてを検出できる。
 */
function checkPwshExists(command) {
  // $PROFILE がロードされない -NoProfile で高速チェック
  // -NoProfile: 関数定義のためにプロファイルをロードする必要はなく、
  //   ここでは単に「pwsh がこの名前をコマンドとして解釈できるか」を確認する。
  //   実起動は profile 込みで行うため、profile-defined 関数の場合は実起動側で解決される。
  //   ただし、関数が $PROFILE でのみ定義されている場合、このチェックは false を返す。
  //   そこで、一度 -NoProfile で失敗した場合は profile 込みでも試す。
  const r1 = spawnSync('pwsh', [
    '-NoLogo', '-NoProfile',
    '-Command', `Get-Command '${command.replace(/'/g, "''")}' -ErrorAction Stop`,
  ], { encoding: 'utf8', stdio: 'pipe' });
  if (r1.status === 0) return true;

  // -NoProfile で見つからなかった場合、profile 込みで再試行
  // （pwsh 関数として定義されている場合に対応）
  const encoded = Buffer.from(
    `Get-Command '${command.replace(/'/g, "''")}' -ErrorAction Stop`,
    'utf16le',
  ).toString('base64');
  const r2 = spawnSync('pwsh', ['-NoLogo', '-EncodedCommand', encoded], {
    encoding: 'utf8', stdio: 'pipe',
  });
  return r2.status === 0;
}

/**
 * Unix: bash -lc で command -v による存在確認。
 * command -v は実行ファイル・関数・エイリアスのすべてを検出できる。
 * -l（ログインシェル）で .bashrc 等のエイリアス/関数定義がロードされる。
 */
function checkBashExists(command) {
  // シングルクォートで囲み、内部の ' は '\'' でエスケープ（bash の方法）
  // シングルクォート内では $ / ` / " はすべてリテラルとして扱われる
  const escaped = command.replace(/'/g, "'\\''");
  const r = spawnSync('bash', ['-lc', `command -v '${escaped}' 2>/dev/null`], {
    encoding: 'utf8', stdio: 'pipe',
  });
  return r.status === 0;
}

module.exports = { buildLoginShellExecArgs, checkAgentExists };
