'use strict';
// session-resume-adapter.js
// 非同期通知を持たないがセッション再開可能なエージェント向け InboxAdapter 実装。
//
// agy / codex / reasonix は Monitor ツールによる非同期通知を持たず、
// 休止後にセッション再開することで新着メッセージを受け取る。
// 稼働中のエージェントには wezterm cli send-text で直接配送する。
//
// require されるだけのモジュール（CLIエントリポイントなし）のため --help 対象外
// （skill-asset-help ルール準拠）。

const { buildAgentCommandArgs } = require('../../agent-launch');
const { formatPlainInboxPrompt } = require('./adapter-base');

// ── 定数 ──────────────────────────────────────────────────────────────────

const STRATEGY_TYPE = 'session-resume';

// ── ヘルパー ──────────────────────────────────────────────────────────────

/**
 * エージェントに与える inbox メッセージ受信プロンプトを生成する。
 * Monitor ツールを持たないエージェント向けに、受信したメッセージ本文を
 * そのまま提示し、処理を促す。
 *
 * @param {import('./adapter-base').Message} message
 * @returns {string} プロンプト文
 */
function buildSessionResumePrompt(message) {
  return formatPlainInboxPrompt(message);
}

// ── 公開API ───────────────────────────────────────────────────────────────

/**
 * 非同期通知非対応・セッション再開可能なエージェント向け InboxAdapter を作成する。
 *
 * @param {object} agentConfig - resolveAgentConfig() で解決済みのエージェント設定。
 *   asynchronousNotification / sessionResume / resumeCommand / extraArgs /
 *   promptDelivery / command を含む。
 * @returns {object} InboxAdapter インターフェースを満たすオブジェクト
 */
function createSessionResumeAdapter(agentConfig) {
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
     * gh-maestro は 1ワーカー1セッションの前提のため、
     * `--continue` / `--last` 等の直近セッション再開フラグで十分である。
     * 特定のセッションID指定が必要になった場合は sessionRef 引数で対応する。
     *
     * @param {string} [sessionRef] - 再開するセッションの参照（通常は不要。
     *   指定があれば resumeCommand 末尾の --last/--continue を上書きする）。
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

      // sessionRef が指定された場合は、resumeCommand の末尾の
      // --last / --continue フラグを sessionRef で置き換える。
      // 前段のサブコマンド（exec / resume 等）はそのまま残す。
      if (sessionRef) {
        const cmdArgs = [...config.resumeCommand];
        cmdArgs[cmdArgs.length - 1] = sessionRef;
        return {
          command: config.command,
          args: [...extraArgs, ...cmdArgs],
        };
      }

      return {
        command: config.command,
        args: [...extraArgs, ...config.resumeCommand],
      };
    },

    /**
     * 新着メッセージをエージェントに伝えるためのプロンプト手順を返す。
     * Monitor ツールを持たないエージェント向けに、受信メッセージの直接提示のみを行う。
     *
     * @param {import('./adapter-base').Message} message
     * @param {object} [_opts={}]
     * @param {string} [_opts.scriptsPath]
     * @param {string} [_opts.workerName]
     * @param {string} [_opts.issue]
     * @param {string} [_opts.workspace]
     * @returns {import('./adapter-base').DeliverResult}
     */
    deliverMessage(message, _opts = {}) {
      if (!message || typeof message !== 'object') {
        throw new Error('message is required');
      }

      const prompt = buildSessionResumePrompt(message);

      return {
        type: STRATEGY_TYPE,
        prompt,
      };
    },

    /**
     * エージェントを終了するための指示を返す。
     * セッション再開型エージェントの場合も、終了は exit 指示で行う。
     *
     * @param {object} [_options]
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

module.exports = { createSessionResumeAdapter, buildSessionResumePrompt, STRATEGY_TYPE };
