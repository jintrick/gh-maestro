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

// ── 定数 ──────────────────────────────────────────────────────────────────

const STRATEGY_TYPE = 'monitor';

// ── ヘルパー ──────────────────────────────────────────────────────────────

/**
 * エージェントに与える Monitor ベースの inbox ポーリング手順プロンプトを生成する。
 * このプロンプトは Supervisor（Issue C）によってエージェントのコンテキストに注入される。
 *
 * deliverMessage() と start() の両方から参照される共有ロジック。
 *
 * @param {object} [opts={}]
 * @param {string} [opts.scriptsPath] - msg-poll.js / msg-read.js / msg-send.js の
 *   存在するディレクトリの絶対パス。省略時は呼び出し元が実行時に解決する前提で
 *   プレースホルダ `{{SCRIPTS_PATH}}` を出力する。
 * @param {string} [opts.workerName]  - ワーカー名
 * @param {string} [opts.issue]       - Issue 番号
 * @param {string} [opts.workspace]   - ワークスペースパス
 * @returns {string} プロンプト文
 */
function buildInboxPollPrompt(opts = {}) {
  const scriptsPath = opts.scriptsPath || '{{SCRIPTS_PATH}}';
  const workerName = opts.workerName || '$WORKER_NAME';
  const issue = opts.issue || '$ISSUE';
  const workspace = opts.workspace || '$WORKSPACE';

  return [
    'Monitorツールを呼び出し、`command` に ' +
    `\`node "${scriptsPath}/msg-poll.js" ${workerName} --issue ${issue} --workspace ${workspace}\` ` +
    'を直接指定して起動する。`persistent: true` を設定すること。',
    '',
    'Monitorから届く通知を処理する：',
    `- \`NEW_MESSAGE:<commentId>\` → \`node "${scriptsPath}/msg-read.js" <commentId> --workspace ${workspace}\` ` +
    'で本文を取得し、メッセージを処理する。処理後は必ず `msg-send.js` で結果を返信すること。' +
    '**完了後は直ちにMonitorに戻る**',
  ].join('\n');
}

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
     * claude の場合は Monitor ツールによる inbox ポーリング手順を生成する。
     *
     * @param {import('./adapter-base').Message} message
     * @param {object} [opts={}]
     * @param {string} [opts.scriptsPath]
     * @param {string} [opts.workerName]
     * @param {string} [opts.issue]
     * @param {string} [opts.workspace]
     * @returns {import('./adapter-base').DeliverResult}
     */
    deliverMessage(message, opts = {}) {
      if (!message || typeof message !== 'object') {
        throw new Error('message is required');
      }

      const prompt = buildInboxPollPrompt(opts);

      // メッセージ本文があれば、プロンプトの前に付与する
      const fullPrompt = message.body
        ? `以下のメッセージを受信しました:\n\n> ${message.body.split('\n').join('\n> ')}\n\n---\n\n${prompt}`
        : prompt;

      return {
        type: STRATEGY_TYPE,
        prompt: fullPrompt,
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

module.exports = { createClaudeAdapter, buildInboxPollPrompt, STRATEGY_TYPE };
