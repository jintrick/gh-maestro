'use strict';

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
 * 呼び出し元は inbox-supervisor.js の resume 配線で、対象は sessionResume: true の全エージェント
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
 *   argv: wezterm split-pane に渡すエージェント起動コマンド一式
 *   afterLaunchText: send-text-after-launch 方式の場合のみ非null（ペイン起動後に別途送信する本文）
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
    case 'system-prompt-file':
      if (!shortPrompt) throw new Error(`shortPrompt is required for ${promptDelivery} delivery`);
      return {
        argv: [command, ...extraArgs, ...resumeArgs, shortPrompt],
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

module.exports = { buildAgentCommandArgs, buildAgentResumeCommandArgs };
