'use strict';
// child_process ラッパー
// Windows では spawn / spawnSync / execSync に自動的に windowsHide: true を注入する。
// これにより子プロセス生成時のコンソールウィンドウポップアップを防止する。
//
// さらに git を実行する際は、環境変数に注入されたリポジトリローカルな GIT_* を除去してから
// spawn する（Issue #283）。git フック（pre-push / pre-commit 等）は実行時に GIT_DIR 等を
// フック環境へ設定し、GIT_DIR は spawnSync の cwd 指定より優先されてリポジトリ発見を
// 上書きする。共有ラッパー経由の全 git 呼び出しで除去することで、テスト（バイパス不要で
// 既存テストが無改変のまま通る）と本番の両方で「cwd が正」（cwd 基準のリポジトリ発見）を
// 保証する。

const { spawn: _spawn, spawnSync: _spawnSync, execSync: _execSync } = require('child_process');
const path = require('path');

// テスト中に外部プロセスを起動しないための共有ガード。NODE_TEST_CONTEXT は node --test が
// テストプロセスとそこから起動された子プロセスへ設定する。明示的な環境変数は、別の
// テストランナーや手動検証で同じ抑止を有効にするために使う。
const REAL_SPAWN_DISABLED_ENV = 'GH_MAESTRO_DISABLE_REAL_SPAWN';
const REAL_SPAWN_DISABLED_ERROR_CODE = 'ERR_GH_MAESTRO_REAL_SPAWN_DISABLED';
const WEZTERM_EXECUTABLE_NAMES = new Set(['wezterm', 'wezterm.exe', 'wezterm.cmd']);
const SHELL_WRAPPER_NAMES = new Map([
  ['cmd', 'cmd'],
  ['cmd.exe', 'cmd'],
  ['powershell', 'powershell'],
  ['powershell.exe', 'powershell'],
  ['pwsh', 'powershell'],
  ['pwsh.exe', 'powershell'],
  ['sh', 'shell'],
  ['sh.exe', 'shell'],
  ['bash', 'shell'],
  ['bash.exe', 'shell'],
  ['zsh', 'shell'],
  ['zsh.exe', 'shell'],
  ['dash', 'shell'],
  ['dash.exe', 'shell'],
]);

function isWeztermExecutable(cmd) {
  const value = String(cmd).trim();
  const names = [path.basename(value), path.win32.basename(value)]
    .map(name => name.toLowerCase());
  return names.some(name => WEZTERM_EXECUTABLE_NAMES.has(name));
}

// execSync はシェルコマンド文字列を受け取るため、簡易な字句分解でコマンド境界と
// 引用符内の文字列を保持する。目的はシェル全体を解釈することではなく、WezTermを
// コマンド位置に置く形式（演算子の後、cmd /c、powershell -Command 等）を見落とさない
// ことに限定する。
function tokenizeShellCommand(command) {
  const tokens = [];
  const value = String(command);
  let word = '';
  let wordStarted = false;
  let quote = null;

  const pushWord = () => {
    if (!wordStarted) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
    wordStarted = false;
  };

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      } else {
        word += char;
      }
      wordStarted = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      wordStarted = true;
      continue;
    }
    if (char === '\n') {
      pushWord();
      tokens.push({ kind: 'operator', value: '\n' });
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }
    if (';&|()'.includes(char)) {
      pushWord();
      const next = value[i + 1];
      if ((char === '&' || char === '|') && next === char) {
        tokens.push({ kind: 'operator', value: char + char });
        i++;
      } else {
        tokens.push({ kind: 'operator', value: char });
      }
      continue;
    }
    word += char;
    wordStarted = true;
  }
  pushWord();
  return tokens;
}

function shellWrapperType(command) {
  const names = [path.basename(String(command)), path.win32.basename(String(command))]
    .map(name => name.toLowerCase());
  return names.map(name => SHELL_WRAPPER_NAMES.get(name)).find(Boolean) || null;
}

function isShellCommandSwitch(wrapperType, value) {
  if (wrapperType === 'cmd') return /^\/[ck]$/i.test(value);
  if (wrapperType === 'powershell') return /^(?:-c|--command|-command)$/i.test(value);
  // bash -c / sh -c のほか、bash -lc のような結合形も扱う。
  return /^(?:-c|--command)$/i.test(value) || /^-[^-]*c[^-]*$/i.test(value);
}

function findShellCommandSwitch(tokens, start, wrapperType) {
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].kind === 'operator') return -1;
    if (isShellCommandSwitch(wrapperType, tokens[i].value)) return i;
  }
  return -1;
}

function containsWeztermShellCommandTokens(tokens, start = 0) {
  let commandStart = true;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'operator') {
      commandStart = true;
      continue;
    }
    if (!commandStart) continue;

    if (isWeztermExecutable(token.value)) return true;

    const wrapperType = shellWrapperType(token.value);
    if (wrapperType) {
      const switchIndex = findShellCommandSwitch(tokens, i + 1, wrapperType);
      if (switchIndex !== -1) {
        const nested = tokens[switchIndex + 1];
        // -Command / /c の値が引用されたコマンド文字列なら、その文字列も再帰的に
        // 解析する。非引用の `cmd /c echo x && wezterm` は下の token 走査で検出する。
        if (nested?.kind === 'word' && containsWeztermShellCommand(nested.value)) return true;
        if (containsWeztermShellCommandTokens(tokens, switchIndex + 1)) return true;
      }
    }
    commandStart = false;
  }
  return false;
}

function containsWeztermShellCommand(command) {
  return containsWeztermShellCommandTokens(tokenizeShellCommand(command));
}

function realSpawnDisabledReason() {
  if (process.env.NODE_TEST_CONTEXT) return 'テスト実行中（NODE_TEST_CONTEXT が設定されています）';
  if (process.env[REAL_SPAWN_DISABLED_ENV]) return `${REAL_SPAWN_DISABLED_ENV} が設定されています`;
  return null;
}

function throwRealSpawnDisabled(command, reason) {
  const error = new Error(`WezTermを起動しません: ${reason}。`);
  error.code = REAL_SPAWN_DISABLED_ERROR_CODE;
  error.command = String(command);
  throw error;
}

function assertWeztermSpawnAllowed(command) {
  const isWezterm = isWeztermExecutable(command);
  if (!isWezterm) return;

  const disabledReason = realSpawnDisabledReason();
  if (disabledReason) throwRealSpawnDisabled(command, disabledReason);
}

// リポジトリの「位置」を決める git 環境変数。これらが残ったまま git を spawn すると
// cwd を無視して実リポジトリへ操作が向く。`git rev-parse --local-env-vars` の一覧から、
// 位置と無関係な設定変数（GIT_CONFIG / GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT）は
// 意図的に除外する。呼び出し元やCI環境が safe.directory 等を渡している場合に、
// gh-maestro の git 呼び出しだけがその設定を失うのを避けるため。加えて
// GIT_QUARANTINE_PATH（--local-env-vars には含まれないがフックが注入する）も除去する。
const GIT_LOCAL_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  'GIT_QUARANTINE_PATH',
];

const injectHide = (opts) =>
  process.platform === 'win32' ? { windowsHide: true, ...opts } : opts;

// spawn / spawnSync は実行ファイル名で判定する（Windows の実体は git.exe、環境によっては git.cmd）。
const isGitExecutable = (cmd) => {
  const base = path.basename(String(cmd)).toLowerCase();
  return base === 'git' || base === 'git.exe' || base === 'git.cmd';
};

// execSync はシェルコマンド文字列を取るため、先頭単語が git かどうかで判定する。
const isGitCommandString = (cmd) => /^\s*git(?:\.exe|\.cmd)?(?:\s|$)/i.test(String(cmd));

// opts.env があればそれを基準に、無ければ process.env を基準に、GIT_* だけを除いた env を作る。
// GIT_* を確実に除去するには spawn の env 継承に任せられないため、env を明示的に渡す。
const stripGitEnv = (opts) => {
  const env = { ...(opts && opts.env ? opts.env : process.env) };
  for (const key of GIT_LOCAL_ENV_VARS) delete env[key];
  return env;
};

const sanitizeOpts = (opts, isGit) => {
  const injected = injectHide(opts);
  if (!isGit) return injected;
  return { ...injected, env: stripGitEnv(injected) };
};

const spawn = (cmd, args, opts) => {
  assertWeztermSpawnAllowed(cmd);
  return _spawn(cmd, args, sanitizeOpts(opts, isGitExecutable(cmd)));
};

const spawnSync = (cmd, args, opts) => {
  assertWeztermSpawnAllowed(cmd);
  return _spawnSync(cmd, args, sanitizeOpts(opts, isGitExecutable(cmd)));
};

const execSync = (cmd, opts) => {
  if (containsWeztermShellCommand(cmd)) {
    const disabledReason = realSpawnDisabledReason();
    if (disabledReason) throwRealSpawnDisabled(cmd, disabledReason);
  }
  return _execSync(cmd, sanitizeOpts(opts, isGitCommandString(cmd)));
};

module.exports = {
  spawn,
  spawnSync,
  execSync,
  REAL_SPAWN_DISABLED_ENV,
  REAL_SPAWN_DISABLED_ERROR_CODE,
};
