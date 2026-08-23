'use strict';

const path = require('path');

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

module.exports = { buildAgentCommandArgs, buildAgentResumeCommandArgs, RESUME_REPORTING_REMINDER };
