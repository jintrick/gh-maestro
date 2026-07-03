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

module.exports = { buildAgentCommandArgs };
