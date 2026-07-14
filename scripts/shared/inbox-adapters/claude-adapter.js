'use strict';
// claude-adapter.js
// Claude Code エージェント向け InboxAdapter 実装。
//
// claude / claude-ds / claude-ds-pro は Monitor ツールによる非同期通知を
// 持つため、"monitor" 戦略として実装される。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { buildAgentCommandArgs } = require('../../agent-launch');
const { formatPlainInboxPrompt } = require('./adapter-base');

// ── 定数 ──────────────────────────────────────────────────────────────────

const STRATEGY_TYPE = 'monitor';

// ── 公開API ───────────────────────────────────────────────────────────────

/**
 * Claude Code エージェント向け InboxAdapter を作成する。
 *
 * @param {object} agentConfig - resolveAgentConfig() で解決済みのエージェント設定。
 *   asynchronousNotification / sessionResume / resumeCommand / extraArgs /
 *   promptDelivery / command を含む。
 * @returns {object} InboxAdapter インターフェースを満たすオブジェクト
 */
function createClaudeAdapter(agentConfig) {
  if (!agentConfig || typeof agentConfig !== 'object') {
    throw new Error('agentConfig is required');
  }
  if (!agentConfig.command) {
    throw new Error('agentConfig.command is required');
  }

  const config = agentConfig;

  return {
    /**
     * この Adapter が担当するエージェントの能力を返す。
     *
     * @returns {import('./adapter-base').AgentCapabilities}
     */
    getCapabilities() {
      return {
        asynchronousNotification: config.asynchronousNotification,
        sessionResume: config.sessionResume,
      };
    },

    /**
     * エージェントを新規起動するためのコマンドと引数を返す。
     * agent-launch.js の buildAgentCommandArgs をラップする。
     *
     * @param {import('./adapter-base').StartOptions} options
     * @returns {import('./adapter-base').StartResult}
     */
    start(options) {
      if (!options || typeof options !== 'object') {
        throw new Error('start options is required');
      }

      const args = buildAgentCommandArgs(config, {
        promptFile: options.promptFile,
        shortPrompt: options.shortPrompt,
        systemPromptText: options.systemPromptText,
      });

      return {
        command: args[0],
        args: args.slice(1),
      };
    },

    /**
     * 中断したセッションを再開するためのコマンドと引数を返す。
     * agent-defaults.json の resumeCommand を使用する。
     *
     * @param {string} [sessionRef] - 再開するセッションの参照（claude の --continue では
     *   最後のセッションが自動選択されるため、通常は不要）。
     * @returns {import('./adapter-base').ResumeResult}
     */
    resume(sessionRef) {
      if (!config.sessionResume) {
        throw new Error(
          `エージェント "${config.id}" は sessionResume に対応していないため、resume() は使用できません。`
        );
      }

      if (!Array.isArray(config.resumeCommand) || config.resumeCommand.length === 0) {
        throw new Error(
          `エージェント "${config.id}" は sessionResume=true ですが、resumeCommand が設定されていません。`
        );
      }

      const extraArgs = config.extraArgs || [];

      return {
        command: config.command,
        args: [...extraArgs, ...config.resumeCommand],
      };
    },

    /**
     * 新着メッセージをエージェントに伝えるためのプロンプト手順を返す。
     * inbox-supervisor.js が既に GitHub Issue を監視し配送しているため、
     * claude の場合も受信したメッセージ本文をそのまま提示するのみで、
     * ワーカー自身にポーリングを開始させる指示は含めない
     * （自前で Monitor 等のポーリングプロセスを起動しないという各 SKILL.md の
     * 方針と、ここで生成する配送文面を一致させる）。
     *
     * @param {import('./adapter-base').Message} message
     * @param {object} [_opts={}] - 未使用（Adapter 共通インターフェースのため受け取る）
     * @returns {import('./adapter-base').DeliverResult}
     */
    deliverMessage(message, _opts = {}) {
      if (!message || typeof message !== 'object') {
        throw new Error('message is required');
      }

      return {
        type: STRATEGY_TYPE,
        prompt: formatPlainInboxPrompt(message),
      };
    },

    /**
     * エージェントを終了するための指示を返す。
     * claude の場合は exit 指示で自発的に終了させる。
     *
     * @param {object} [options]
     * @returns {import('./adapter-base').StopResult}
     */
    stop(_options) {
      return {
        action: 'exit',
        description: 'エージェントに終了指示（exit）を送る',
      };
    },
  };
}

module.exports = { createClaudeAdapter, STRATEGY_TYPE };
