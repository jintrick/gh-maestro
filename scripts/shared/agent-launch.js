'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('./child-process');
const { buildLoginShellExecArgs } = require('./agent-exec');
const { withTempDir } = require('./temp-directory');

const RESULT_FILE_TOKEN = '{{GH_MAESTRO_RESULT_FILE}}';

function agentLaunchConfigError(message) {
  const error = new Error(message);
  error.code = 'ERR_AGENT_LAUNCH_CONFIG';
  return error;
}

// resume起動（--continue）はメッセージ履歴を復元するが、システムプロンプトは復元しない
// （Claude Code公式ドキュメント: 「These flags apply only to the current invocation」）。
// 初回spawn時にsystem-prompt-file配送で注入した報告プロトコル（msg-send.js経由での報告義務・
// 位置引数禁止）は、resumeのたびに新しいプロセスとして起動される都合上、再注入しない限り
// そのターンのシステムプロンプトから欠落する。結果、コーダーが正しく考えて回答しても
// msg-send.jsを一度も呼ばずにチャット出力だけで終える実障害があった。
// resumeは全エージェント共通経路（buildAgentResumeCommandArgs）なので、ここで一度だけ
// 定義し、system-prompt-file配送（claude系）の全resumeに機械的に乗せる。
const MSG_SEND_PATH = path.join(__dirname, '..', 'msg-send.js').replace(/\\/g, '/');
const RESUME_REPORTING_REMINDER = [
  '[gh-maestro] セッション再開時のリマインダーです。作業結果・質問・報告は、チャットへの回答だけでは',
  'orchestratorに届きません。必ず次のコマンドをツール呼び出しとして実行して伝えてください：',
  '',
  `  node "${MSG_SEND_PATH}" --stdin <<'EOF'`,
  '  <内容>',
  '  EOF',
  '',
  '本文は必ず --stdin または --body-file で渡すこと。位置引数で渡すとmsg-send.jsがエラーで',
  '拒否します（短い本文でも例外はありません）。ヒアドキュメントの終端記号は必ずクォート付き',
  '（<<\'EOF\'）にすること。着手報告は不要です。処理を終えたら結果を返信してください。',
].join('\n');

function buildAgentCommandArgs(agentConfig, opts = {}) {
  if (!agentConfig || typeof agentConfig !== 'object') {
    throw new Error('agentConfig is required');
  }

  const command = agentConfig.command;
  if (!command) throw new Error('agentConfig.command is required');

  const extraArgs = agentConfig.extraArgs || [];
  const promptDelivery = agentConfig.promptDelivery;
  const promptFile = opts.promptFile;
  const shortPrompt = opts.shortPrompt;
  const systemPromptText = opts.systemPromptText;

  switch (promptDelivery) {
    case 'system-prompt-file':
      if (!promptFile) throw new Error('promptFile is required for system-prompt-file delivery');
      if (!systemPromptText) throw new Error('systemPromptText is required for system-prompt-file delivery');
      return [
        command,
        ...extraArgs,
        '--append-system-prompt-file',
        promptFile,
        systemPromptText,
      ];

    case 'flag':
      if (!agentConfig.promptFlag) throw new Error('agentConfig.promptFlag is required for flag delivery');
      if (!shortPrompt) throw new Error('shortPrompt is required for flag delivery');
      return [command, ...extraArgs, agentConfig.promptFlag, shortPrompt];

    case 'positional':
      if (!shortPrompt) throw new Error('shortPrompt is required for positional delivery');
      return [command, ...extraArgs, shortPrompt];

    case 'send-text-after-launch':
      return [command, ...extraArgs];

    default:
      throw new Error(`unknown promptDelivery: ${promptDelivery}`);
  }
}

/**
 * 起動入口で使うエージェント設定を正規化する。
 * exec用の設定を優先し、ジョブのcwdを `{workspace}` へ埋め込む。
 * 呼び出し側が配送方式や引数を組み立てると、エージェントごとの差分が
 * 複数箇所へ漏れるため、この入口だけで解決する。
 *
 * @param {object} agentConfig
 * @param {string} cwd
 * @returns {object}
 */
function normalizeAgentLaunchConfig(agentConfig, cwd) {
  if (!agentConfig || typeof agentConfig !== 'object') {
    throw agentLaunchConfigError('agentConfig is required');
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('cwd must be a non-empty string');
  }

  const configuredArgs = agentConfig.execArgs ?? agentConfig.extraArgs ?? [];
  if (!Array.isArray(configuredArgs) || configuredArgs.some(arg => typeof arg !== 'string')) {
    throw agentLaunchConfigError('agentConfig execArgs/extraArgs must be an array of strings');
  }

  const promptDelivery = agentConfig.execPromptDelivery ?? agentConfig.promptDelivery;
  const promptFlag = agentConfig.execPromptFlag ?? agentConfig.promptFlag;
  if (!['flag', 'positional', 'system-prompt-file'].includes(promptDelivery)) {
    throw agentLaunchConfigError(`agent "${agentConfig.id}" prompt delivery "${promptDelivery}" is not supported for headless review`);
  }
  if (promptDelivery === 'flag' && !promptFlag) {
    throw agentLaunchConfigError(`agent "${agentConfig.id}" promptFlag is required for headless review`);
  }

  return {
    ...agentConfig,
    extraArgs: configuredArgs.map(arg => arg.replace(/\{workspace\}/g, cwd)),
    promptDelivery,
    promptFlag,
  };
}

/**
 * プロンプトを一時ファイル経由で配送してエージェントを1回起動する。
 *
 * プロンプトファイル、結果ファイル、起動argvはこの関数のスコープ内だけで扱う。
 * 呼び出し側には子プロセスの観測結果と、任意の結果ファイル本文だけを返す。
 * withTempDir は非同期 callback の完了後に所有ディレクトリを必ず閉じるため、
 * 正常終了・spawn失敗・例外・タイムアウトのどの経路でも同じ寿命境界になる。
 *
 * @param {object} opts
 * @param {object} opts.agentConfig 解決済みエージェント設定
 * @param {string} opts.promptText 指示文本文
 * @param {string} opts.cwd エージェントの作業ディレクトリ
 * @param {string} [opts.systemPromptText] system-prompt-file配送時の補助システム文
 * @param {string} [opts.resultFileName] 結果ファイル名。指定時は結果本文を戻り値へ含める
 * @param {string} [opts.tempPrefix='gh-maestro-agent-'] 一時ディレクトリ接頭辞
 * @param {object} [opts.tempDirOptions] 既存temp-directory.jsへ渡すテスト/実行オプション
 * @param {object} [opts.spawnOptions] child-process spawn options（cwd/env/stdio等）
 * @param {Function} [opts.spawnFn=spawn] テスト用spawn注入口
 * @param {Function} [opts.onSpawn] spawn直後に子プロセスを受け取るobserver
 * @param {Function} [opts.observe] 子プロセスの完了・監督を待つcallback
 * @param {Function} [opts.cleanup] プロセス側リソースの後始末callback
 * @param {Function} [opts.log] 内部で構築した起動内容を記録するcallback
 * @returns {Promise<{observed: *, resultFileText?: string|null}>}
 */
function runAgentWithPrompt({
  agentConfig,
  promptText,
  cwd,
  systemPromptText,
  resultFileName,
  tempPrefix = 'gh-maestro-agent-',
  tempDirOptions,
  spawnOptions = {},
  spawnFn = spawn,
  onSpawn,
  observe,
  cleanup,
  log,
}) {
  if (typeof promptText !== 'string') throw new TypeError('promptText must be a string');
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('cwd must be a non-empty string');
  if (typeof spawnFn !== 'function') throw new TypeError('spawnFn must be a function');
  if (onSpawn !== undefined && typeof onSpawn !== 'function') throw new TypeError('onSpawn must be a function');
  if (observe !== undefined && typeof observe !== 'function') throw new TypeError('observe must be a function');
  if (cleanup !== undefined && typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
  if (resultFileName !== undefined && (
    typeof resultFileName !== 'string' ||
    resultFileName.length === 0 ||
    path.basename(resultFileName) !== resultFileName
  )) {
    throw new TypeError('resultFileName must be a non-empty file name');
  }
  if (resultFileName === undefined && promptText.includes(RESULT_FILE_TOKEN)) {
    throw new Error('prompt contains RESULT_FILE_TOKEN but resultFileName is not configured');
  }

  return withTempDir(tempPrefix, async (tempDir) => {
    const promptFile = path.join(tempDir, 'prompt.md');
    const resultFile = resultFileName ? path.join(tempDir, resultFileName) : null;
    const resolvedPrompt = resultFile
      ? promptText.split(RESULT_FILE_TOKEN).join(resultFile)
      : promptText;
    let child;

    try {
      // このディレクトリとその中のファイルの所有は withTempDir に限定する。
      fs.writeFileSync(promptFile, resolvedPrompt, 'utf8');

      const launchConfig = normalizeAgentLaunchConfig(agentConfig, cwd);
      const agentArgs = buildAgentCommandArgs(launchConfig, {
        promptFile,
        // Windowsパスを短い指示文へ埋め込む場合もシェルの再解釈を避ける。
        shortPrompt: `Read ${promptFile.replace(/\\/g, '/')} and execute it.`,
        systemPromptText,
      });
      const shellArgs = buildLoginShellExecArgs(agentArgs, process.platform);
      if (typeof log === 'function') log(agentArgs);

      try {
        child = spawnFn(shellArgs[0], shellArgs.slice(1), {
          cwd,
          env: process.env,
          ...spawnOptions,
        });
      } catch (error) {
        const spawnError = new Error(`spawn failed: ${error.message}`);
        spawnError.cause = error;
        throw spawnError;
      }
      if (!child || typeof child.on !== 'function') {
        throw new Error('spawn returned an invalid child process handle');
      }
      if (typeof onSpawn === 'function') onSpawn(child);
      const observed = typeof observe === 'function' ? await observe(child) : undefined;

      let resultFileText;
      if (resultFile) {
        try {
          resultFileText = fs.readFileSync(resultFile, 'utf8');
        } catch {
          resultFileText = null;
        }
      }
      return { observed, resultFileText };
    } finally {
      if (typeof cleanup === 'function') await cleanup(child);
    }
  }, tempDirOptions);
}

/**
 * セッション再開（resume）用の起動 argv を構築する。
 *
 * buildAgentCommandArgs と同じ promptDelivery 分岐を使うが、"新規セッション" を前提にした
 * プロンプト配送ではなく、resumeArgs（Adapter の resume() が返す args）をコマンドに組み込む。
 * 呼び出し元は worker-supervisor.js の resume 配線で、対象は全エージェント
 * （claude/claude-ds/claude-ds-pro/reasonix/agy/codex/codex-pro）。
 * resume 時は前回セッションのコンテキストが `--continue` 等で復元されるため、
 * claude 系の system-prompt-file（初回起動時のみ必要な役割・スキル文書の注入）は不要で、
 * 新着メッセージを positional と同じ形で末尾に渡すだけでよい。
 *
 * @param {object} agentConfig
 * @param {string[]} resumeArgs - Adapter の resume() が返す args（例: ['--continue']）
 * @param {object} opts
 * @param {string} opts.shortPrompt - 再開後に伝える新着メッセージ本文
 * @returns {{ argv: string[], afterLaunchText: string|null }}
 *   argv: エージェント起動コマンド一式（headless-launch.js へ渡す）
 *   afterLaunchText: send-text-after-launch 方式の場合のみ非null。headless実行では
 *     画面への入力注入ができないため、呼び出し元はこれが非nullなら配送を中止する
 */
function buildAgentResumeCommandArgs(agentConfig, resumeArgs, opts = {}) {
  if (!agentConfig || typeof agentConfig !== 'object') {
    throw new Error('agentConfig is required');
  }
  if (!Array.isArray(resumeArgs)) {
    throw new Error('resumeArgs must be an array');
  }

  const command = agentConfig.command;
  if (!command) throw new Error('agentConfig.command is required');

  const extraArgs = agentConfig.extraArgs || [];
  const promptDelivery = agentConfig.promptDelivery;
  const shortPrompt = opts.shortPrompt;

  switch (promptDelivery) {
    case 'flag':
      if (!agentConfig.promptFlag) throw new Error('agentConfig.promptFlag is required for flag delivery');
      if (!shortPrompt) throw new Error('shortPrompt is required for flag delivery');
      return {
        argv: [command, ...extraArgs, ...resumeArgs, agentConfig.promptFlag, shortPrompt],
        afterLaunchText: null,
      };

    case 'positional':
      if (!shortPrompt) throw new Error(`shortPrompt is required for ${promptDelivery} delivery`);
      return {
        argv: [command, ...extraArgs, ...resumeArgs, shortPrompt],
        afterLaunchText: null,
      };

    case 'system-prompt-file':
      if (!shortPrompt) throw new Error(`shortPrompt is required for ${promptDelivery} delivery`);
      return {
        argv: [
          command, ...extraArgs, ...resumeArgs,
          '--append-system-prompt', RESUME_REPORTING_REMINDER,
          shortPrompt,
        ],
        afterLaunchText: null,
      };

    case 'send-text-after-launch':
      if (!shortPrompt) throw new Error('shortPrompt is required for send-text-after-launch delivery');
      return {
        argv: [command, ...extraArgs, ...resumeArgs],
        afterLaunchText: shortPrompt,
      };

    default:
      throw new Error(`buildAgentResumeCommandArgs は promptDelivery "${promptDelivery}" に対応していません（flag/positional/system-prompt-file/send-text-after-launchのみ対応）`);
  }
}

module.exports = {
  buildAgentCommandArgs,
  buildAgentResumeCommandArgs,
  runAgentWithPrompt,
  RESULT_FILE_TOKEN,
  RESUME_REPORTING_REMINDER,
};
