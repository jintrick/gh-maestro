'use strict';
// run-council-jobs.js — council の意見/投票フェーズで参加者ジョブをヘッドレス起動する
// 機械的な実行器（run-council.js から require されるモジュール。CLI エントリポイント
// なしのため --help 対象外）。
//
// run-review-jobs.js の「manifest検証 → ヘッドレス起動 → 全員完了待ちバリア →
// stdout から JSON 回収 → スキーマ検証」構造を council 向けに一般化したもの:
//   - ジョブごとに agent を解決する（review は共有エージェント1つ）
//   - ジョブ cwd は議論用worktree。プロンプトへ議題 + context_appendix 全文を
//     埋め込み、worktree 閲覧の逃げ道を案内する（判断⑤）
//   - 出力は単一 JSON オブジェクト（opinion / vote）。council-schemas.json で
//     スキーマ検証。スキーマ違反は exit 0 でも非成功とみなし、再試行対象にする
//     （実行契約）
//
// 再試行・欠席・クォーラム判定は行わない（それらは run-council.js の責務）。
// 本モジュールは「与えられた参加者集合を1回実行して結果を返す」だけの
// stateless な実行器。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('./child-process');
const { buildAgentCommandArgs } = require('./agent-launch');
const { buildLoginShellExecArgs } = require('./agent-exec');
const { resolveAgentConfig, validateNonInteractiveTokens } = require('./shared/resolve-config');
const { workerLogPath } = require('./shared/headless-launch');
const { _validateAgainstSchema } = require('./shared/json-schema');

const councilSchemas = require('./council-schemas.json');

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000; // ジョブごと10分
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60 * 1000; // 全体30分

// ── manifest検証 ───────────────────────────────────────────────────────────────

/**
 * フェーズマニフェストの機械的整合性を検証する。
 * council-schemas.json の manifest スキーマに加え、フェーズ固有の要件と
 * 参加者IDの重複を検査する。
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be a JSON object'] };
  }
  const errors = _validateAgainstSchema(manifest, councilSchemas.manifest, 'manifest');

  if (manifest.phase === 'vote') {
    // 投票対象の意見はマニフェストに含める（choice/agrees_with の検証にも使う）
    if (!Array.isArray(manifest.opinions) || manifest.opinions.length === 0) {
      errors.push('vote manifest requires non-empty opinions (opinion-phase successes)');
    }
  }

  // 同一マニフェスト内で同一参加者を2回起動するのは設計外
  if (Array.isArray(manifest.participants)) {
    const seen = new Set();
    for (const p of manifest.participants) {
      if (p && typeof p.participant_id === 'string') {
        if (seen.has(p.participant_id)) {
          errors.push(`duplicate participant_id in manifest: ${p.participant_id}`);
        }
        seen.add(p.participant_id);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── プロンプト生成 ─────────────────────────────────────────────────────────────

/**
 * 参加者ジョブに渡すプロンプトを生成する。
 * 判断⑤: 背景コンテクスト（agenda + context_appendix 全文）をプロンプトへ埋め込み、
 * 探索を前提としない。議論用worktree内の読み取りだけを逃げ道として案内する。
 *
 * @param {{ participant_id: string, agent_id: string }} participant
 * @param {object} manifest
 * @returns {string}
 */
function buildPhasePrompt(participant, manifest) {
  const appendix = manifest.context_appendix
    ? `\n${manifest.context_appendix}\n`
    : '\n（背景コンテクストの付録はありません）\n';
  const agenda = manifest.agenda || '';
  const worktreeGuidance =
    '作業ディレクトリはリポジトリの議論用worktreeです（読み取り専用）。\n' +
    '付録の内容で通常は十分なので、基本的に追加の探索は不要です。\n' +
    'ただし判断に必要なら、このworktree内で確認してよい。';

  if (manifest.phase === 'vote') {
    const opinionsSection = (manifest.opinions || [])
      .map((op) => `### ${op.participant_id}\n\n${op.opinion}`)
      .join('\n\n---\n\n');
    return `あなたは gh-maestro council の参加者です（participant_id: ${participant.participant_id}）。
議題「${manifest.title}」について、意見表明フェーズで出そろった以下の意見から、
あなたが最も妥当だと思う1つに投票してください。

## 議題

${agenda}

## 背景コンテクスト（付録）

${appendix}

## 投票対象の意見一覧

${opinionsSection}

## 作業ディレクトリ

${worktreeGuidance}

## 禁止事項

- ファイル書き込み・git操作・GitHub投稿・ネットワークアクセスは禁止
- 投票対象は上記の意見一覧に含まれる参加者IDのみ（自分自身でも可）

## 出力形式

以下のJSONオブジェクトだけを標準出力に返してください。
JSON以外の説明・Markdown・コメントを絶対に混ぜないでください。

\`\`\`json
{
  "participant_id": "${participant.participant_id}",
  "choice": "<投票する参加者ID>",
  "rationale": "<投票理由>",
  "agrees_with": ["<賛同する参加者ID>"]
}
\`\`\`

- \`participant_id\`: 必ず "${participant.participant_id}" にしてください
- \`choice\`: 意見一覧の参加者IDのいずれか（必須）
- \`rationale\`: 必須（非空）
- \`agrees_with\`: 任意。賛同する参加者IDの配列
`;
  }

  // opinion phase
  return `あなたは gh-maestro council の参加者です（participant_id: ${participant.participant_id}）。
議題「${manifest.title}」について、独立した意見を表明してください。
他の参加者の意見を参照せず、あなた自身の見解だけを述べてください。

## 議題

${agenda}

## 背景コンテクスト（付録）

${appendix}

## 作業ディレクトリ

${worktreeGuidance}

## 禁止事項

- ファイル書き込み・git操作・GitHub投稿・ネットワークアクセスは禁止
- 他の参加者の意見を参照しない（意見表明は独立に行う）

## 出力形式

以下のJSONオブジェクトだけを標準出力に返してください。
JSON以外の説明・Markdown・コメントを絶対に混ぜないでください。

\`\`\`json
{
  "participant_id": "${participant.participant_id}",
  "opinion": "<議題に対する自由記述の意見>",
  "stance": "AGREE",
  "key_points": ["<要点1>"],
  "risks": ["<リスク1>"]
}
\`\`\`

- \`participant_id\`: 必ず "${participant.participant_id}" にしてください
- \`stance\`: AGREE | DISAGREE | NEUTRAL のいずれか（必須）
- \`opinion\`: 必須（非空）
- \`key_points\` / \`risks\`: 任意配列
`;
}

// ── 出力検証 ───────────────────────────────────────────────────────────────────

/**
 * 参加者の出力をスキーマ + 参加者横断の整合性で検証する。
 * スキーマ違反は exit 0 でも非成功とみなす（実行契約）。
 *
 * @param {'opinion'|'vote'} phase
 * @param {object|null} output
 * @param {object} manifest
 * @param {string} participantId
 * @returns {string[]} エラー一覧（空なら成功）
 */
function validateParticipantOutput(phase, output, manifest, participantId) {
  const schema = phase === 'vote' ? councilSchemas.vote : councilSchemas.opinion;
  const errors = _validateAgainstSchema(output, schema, 'output');
  if (!output) return errors;

  if (typeof output.participant_id === 'string' && output.participant_id !== participantId) {
    errors.push(`output.participant_id "${output.participant_id}" does not match job participant "${participantId}"`);
  }

  if (phase === 'vote') {
    const opinionIds = new Set((manifest.opinions || []).map((o) => o.participant_id));
    if (typeof output.choice === 'string' && !opinionIds.has(output.choice)) {
      errors.push(`output.choice "${output.choice}" is not an opinion-phase participant`);
    }
    if (Array.isArray(output.agrees_with)) {
      for (const id of output.agrees_with) {
        if (typeof id === 'string' && !opinionIds.has(id)) {
          errors.push(`output.agrees_with "${id}" is not an opinion-phase participant`);
        }
      }
    }
  }
  return errors;
}

// ── stdout からの JSON 抽出 ────────────────────────────────────────────────────

/**
 * stdout からJSONオブジェクトを抽出する。
 * 各 '{' 位置から文字列リテラルを考慮して対応する '}' までを切り出し、最初に
 * JSON.parse が成功した候補を返す。前後の説明文・Markdown・雑多な波括弧を許容する
 * （run-review-jobs.js の「stdout.match → JSON.parse」パターンの堅牢版）。
 *
 * @param {string} stdout
 * @returns {object|null}
 */
function extractJsonObject(stdout) {
  const text = String(stdout);
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') { depth += 1; continue; }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

// ── 参加者ジョブ起動 ───────────────────────────────────────────────────────────

/**
 * 参加者1名をヘッドレス起動し、stdout から JSON を回収・検証する。
 * run-review-jobs.js の launchJobWorker を council 向けに一般化したもの。
 *
 * スキーマ違反・participant_id不一致・投票対象外IDへの投票は exit 0 でも
 * status: 'failed' として返す（実行契約。再試行対象）。
 *
 * @param {object} opts
 * @param {object} opts.participant  - { participant_id, agent_id }
 * @param {object} opts.manifest     - フェーズマニフェスト
 * @param {object} opts.agentConfig  - 解決済みエージェント設定
 * @param {string} opts.worktreeDir  - ジョブcwd（議論用worktree）
 * @param {string} opts.workspace    - メインワークスペース（workerLogPath 用）
 * @param {number} [opts.timeoutMs]  - ジョブごとのタイムアウト
 * @param {number} [opts.attempt]    - 試行回数（再試行時の報告用）
 * @param {{child: object|null}|null} [opts.childRef] - 全体タイムアウトで kill するための参照
 * @returns {Promise<object>}
 */
function launchParticipantJob({ participant, manifest, agentConfig, worktreeDir, workspace, timeoutMs = DEFAULT_JOB_TIMEOUT_MS, attempt = 1, childRef = null }) {
  const participantId = participant.participant_id;
  return new Promise((resolve) => {
    // 非対話化トークン検証（フェイルクローズ、Issue #163 Review Manager指摘）。
    // 実際に起動引数に使う execArgs ?? extraArgs を検証してから spawn する。
    const tokenCheck = validateNonInteractiveTokens(agentConfig, agentConfig.execArgs ?? agentConfig.extraArgs);
    if (!tokenCheck.valid) {
      resolve({
        participant_id: participantId,
        status: 'failed',
        attempt,
        error: `agent "${agentConfig.id}" execArgs/extraArgs is missing non-interactive token(s): ${tokenCheck.missing.join(', ')} (check ~/.gh-maestro/config.json agents["${agentConfig.id}"].execArgs / extraArgs)`,
      });
      return;
    }

    const promptText = buildPhasePrompt(participant, manifest);
    const promptFile = path.join(os.tmpdir(), `council-${manifest.session}-${participantId}-${Date.now()}.md`);
    try {
      fs.writeFileSync(promptFile, promptText, 'utf8');
    } catch (e) {
      resolve({ participant_id: participantId, status: 'failed', attempt, error: `prompt file write failed: ${e.message}` });
      return;
    }

    // `{workspace}` プレースホルダーはジョブcwd（議論用worktree）へ置換する
    const extraArgs = (agentConfig.execArgs ?? agentConfig.extraArgs ?? [])
      .map(a => a.replace(/\{workspace\}/g, worktreeDir));

    const agentArgs = buildAgentCommandArgs({
      ...agentConfig,
      extraArgs,
      promptDelivery: agentConfig.execPromptDelivery ?? agentConfig.promptDelivery,
      promptFlag: agentConfig.execPromptFlag ?? agentConfig.promptFlag,
    }, {
      promptFile,
      shortPrompt: `Read ${promptFile.replace(/\\/g, '/')} and execute it.`,
      systemPromptText: `あなたは gh-maestro council の参加者です（participant_id: ${participantId}）。${manifest.title}の議論に参加してください。`,
    });

    const shellArgs = buildLoginShellExecArgs(agentArgs, process.platform);

    const logFile = workerLogPath(workspace, `council-${manifest.session}-${participantId}`);
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); } catch {}

    let stderrFd;
    try {
      stderrFd = fs.openSync(logFile, 'a');
    } catch (e) {
      try { fs.unlinkSync(promptFile); } catch {}
      resolve({ participant_id: participantId, status: 'failed', attempt, error: `log file open failed: ${e.message}` });
      return;
    }

    let child;
    try {
      child = spawn(shellArgs[0], shellArgs.slice(1), {
        cwd: worktreeDir,
        env: process.env,
        stdio: ['ignore', 'pipe', stderrFd],
      });
      if (childRef) childRef.child = child;
    } catch (e) {
      try { fs.closeSync(stderrFd); } catch {}
      try { fs.unlinkSync(promptFile); } catch {}
      resolve({ participant_id: participantId, status: 'failed', attempt, error: `spawn failed: ${e.message}` });
      return;
    }

    const stdoutChunks = [];
    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });

    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      try { fs.closeSync(stderrFd); } catch {}
      try { fs.unlinkSync(promptFile); } catch {}
    };

    child.on('close', (code) => {
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();

      if (code !== 0) {
        resolve({
          participant_id: participantId,
          status: 'failed',
          attempt,
          error: `agent exited with code ${code}${stdout ? ': ' + stdout.slice(0, 500) : ''}`,
        });
        return;
      }

      const output = extractJsonObject(stdout);
      if (output === null) {
        resolve({
          participant_id: participantId,
          status: 'failed',
          attempt,
          error: `no valid JSON object found in stdout. preview: ${stdout.slice(0, 500)}`,
        });
        return;
      }

      const errors = validateParticipantOutput(manifest.phase, output, manifest, participantId);
      if (errors.length > 0) {
        resolve({
          participant_id: participantId,
          status: 'failed',
          attempt,
          error: `output validation: ${errors.join('; ')}`,
        });
        return;
      }

      resolve({ participant_id: participantId, status: 'success', attempt, output });
    });

    child.on('error', (err) => {
      cleanup();
      resolve({ participant_id: participantId, status: 'failed', attempt, error: `agent process error: ${err.message}` });
    });
  });
}

// ── フェーズ実行 ───────────────────────────────────────────────────────────────

/**
 * フェーズマニフェストに従って全参加者ジョブを並列起動し、結果を返す。
 *
 * クォーラム判定・再試行・欠席処理は行わない（run-council.js の責務）。
 * 戻り値 ok は「実行機構の構造的成否」（manifest不正・全体タイムアウト）だけを表し、
 * 参加者個別の成否は results 側で報告される。
 *
 * @param {object} opts
 * @param {object} opts.manifest          - フェーズマニフェスト（validateManifest 済み前提の実行器）
 * @param {string} opts.workspace         - メインワークスペース（agent解決・workerLogPath 用）
 * @param {number} [opts.jobTimeoutMs]    - 参加者ジョブごとのタイムアウト
 * @param {number} [opts.totalTimeoutMs]  - フェーズ全体のタイムアウト
 * @returns {Promise<{ok: boolean, timedOut: boolean, results: object[], error?: string, details?: string[]}>}
 */
async function runPhaseJobs({ manifest, workspace, jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS, totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS }) {
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    return {
      ok: false,
      timedOut: false,
      results: [],
      error: 'manifest validation failed',
      details: validation.errors,
    };
  }

  // 参加者ごとにエージェントを解決する（review の共有エージェントとは違い、
  // council は participant.agent_id をそのまま使う。一般化点1）
  const homedir = process.env.HOME || process.env.USERPROFILE || '';
  const activeChildren = [];
  const jobPromises = manifest.participants.map((participant) => {
    const agentConfig = resolveAgentConfig(participant.agent_id, { workspace, homedir });
    if (!agentConfig) {
      return Promise.resolve({
        participant_id: participant.participant_id,
        status: 'failed',
        attempt: 1,
        error: `agent config resolve failed for "${participant.agent_id}"`,
      });
    }
    const childRef = { child: null };
    activeChildren.push(childRef);
    return launchParticipantJob({
      participant,
      manifest,
      agentConfig,
      worktreeDir: manifest.worktree,
      workspace,
      timeoutMs: jobTimeoutMs,
      childRef,
    });
  });

  // 全体タイムアウト: 締切到達時に残っている子プロセスを実際に終了させる。
  // 全ジョブが先に完了した場合はタイマーを明示解除し、プロセスを生かし続けない。
  let totalTimedOut = false;
  let totalTimerHandle = null;
  const totalTimer = new Promise((resolve) => {
    totalTimerHandle = setTimeout(() => {
      totalTimedOut = true;
      for (const ref of activeChildren) {
        try { if (ref.child) ref.child.kill(); } catch {}
      }
      resolve('total-timeout');
    }, totalTimeoutMs);
  });

  const allJobsPromise = Promise.all(jobPromises);
  const raceResult = await Promise.race([allJobsPromise, totalTimer]);
  if (raceResult !== 'total-timeout' && totalTimerHandle) {
    clearTimeout(totalTimerHandle);
  }

  let results;
  if (raceResult === 'total-timeout') {
    // killされたジョブは自然に解決されるが、settledで保証する
    const settled = await Promise.allSettled(jobPromises);
    results = manifest.participants.map((participant, i) => {
      if (settled[i].status === 'fulfilled') return settled[i].value;
      return {
        participant_id: participant.participant_id,
        status: 'failed',
        attempt: 1,
        error: 'job timeout (total deadline reached)',
      };
    });
  } else {
    results = raceResult;
  }

  return { ok: true, timedOut: totalTimedOut, results };
}

// ── 公開API ─────────────────────────────────────────────────────────────────

module.exports = {
  validateManifest,
  buildPhasePrompt,
  validateParticipantOutput,
  extractJsonObject,
  launchParticipantJob,
  runPhaseJobs,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
};
