'use strict';
// pr-checks.js — PRの現在HEADに紐づくGitHub checks / commit statusesを取得する

const { spawnSync } = require('./child-process');
const { SHA_RE, readPrHead } = require('./pr-view');

const GH_TIMEOUT_MS = 30000;
const FAILING_CONCLUSIONS = new Set([
  'action_required', 'cancelled', 'failure', 'request_error', 'stale', 'startup_failure', 'timed_out',
]);
const RUNNING_CHECK_STATUSES = new Set(['in_progress', 'pending', 'queued', 'requested', 'waiting']);

function ghApi(endpoint, opts = {}) {
  return spawnSync('gh', ['api', '--paginate', '--slurp', endpoint], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    ...opts,
  });
}

function parseJson(stdout, label) {
  try {
    return { ok: true, value: JSON.parse(stdout || '') };
  } catch (err) {
    return { ok: false, error: `${label}のJSONパースに失敗しました: ${err.message}` };
  }
}

function flattenPages(value, label) {
  if (!Array.isArray(value)) return { ok: false, error: `${label}の応答が配列ではありません` };
  if (value.length > 0 && value.every(Array.isArray)) return { ok: true, items: value.flat() };
  return { ok: true, items: value };
}

function mapCheckRunState(status, conclusion) {
  if (status !== 'completed') {
    return RUNNING_CHECK_STATUSES.has(status) ? 'running' : 'other';
  }
  if (conclusion === 'success') return 'success';
  if (FAILING_CONCLUSIONS.has(conclusion)) return 'failure';
  return 'other';
}

function mapCommitStatusState(state) {
  if (state === 'success') return 'success';
  if (state === 'failure' || state === 'error') return 'failure';
  if (state === 'pending') return 'running';
  return 'other';
}

function getDetailsUrl(preferred, fallback) {
  return typeof preferred === 'string' && preferred.trim() ? preferred : fallback;
}

function parseCheckRuns(stdout, headSha, repo) {
  const parsed = parseJson(stdout, 'Check Runs');
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return { ok: false, error: 'Check Runsのページ応答が配列ではありません' };

  const candidates = [];
  for (const page of parsed.value) {
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.check_runs)) {
      return { ok: false, error: 'Check Runsのページ形式が不正です' };
    }
    for (const run of page.check_runs) {
      if (!run || typeof run !== 'object' || Array.isArray(run)
          || typeof run.name !== 'string' || typeof run.status !== 'string'
          || typeof run.head_sha !== 'string' || !SHA_RE.test(run.head_sha)) {
        return { ok: false, error: 'Check Runの形式が不正です' };
      }
      if (run.head_sha.toLowerCase() !== headSha.toLowerCase()) {
        return { ok: false, error: `Check RunのHEADが対象と一致しません: ${run.head_sha}` };
      }
      const appId = run.app && typeof run.app.id === 'number' ? String(run.app.id) : '';
      const checkSuiteId = run.check_suite && (typeof run.check_suite.id === 'number'
        || typeof run.check_suite.id === 'string') ? String(run.check_suite.id) : '';
      const attempt = Number.isFinite(run.run_attempt) ? run.run_attempt : 0;
      const startedAt = typeof run.started_at === 'string' ? Date.parse(run.started_at) : 0;
      candidates.push({
        // 同一check suiteのrerunでは最新attemptを使うが、別suiteの同名checkは残す。
        key: `${run.name}\0${appId}\0${checkSuiteId || run.id || candidates.length}`,
        attempt,
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
        check: {
          kind: 'check_run',
          name: run.name,
          state: mapCheckRunState(run.status, run.conclusion),
          detailsUrl: getDetailsUrl(run.details_url, getDetailsUrl(
            run.html_url,
            `https://github.com/${repo}/commit/${headSha}/checks`,
          )),
        },
      });
    }
  }

  const latest = new Map();
  for (const candidate of candidates) {
    const previous = latest.get(candidate.key);
    if (!previous || candidate.attempt > previous.attempt
        || (candidate.attempt === previous.attempt && candidate.startedAt > previous.startedAt)) {
      latest.set(candidate.key, candidate);
    }
  }
  return { ok: true, checks: [...latest.values()].map(({ check }) => check) };
}

function parseCommitStatuses(stdout, headSha, repo) {
  const parsed = parseJson(stdout, 'commit statuses');
  if (!parsed.ok) return parsed;
  const pages = flattenPages(parsed.value, 'commit statuses');
  if (!pages.ok) return pages;

  const latest = new Map();
  for (const status of pages.items) {
    if (!status || typeof status !== 'object' || Array.isArray(status)
        || typeof status.context !== 'string' || typeof status.state !== 'string') {
      return { ok: false, error: 'commit statusの形式が不正です' };
    }
    if (status.sha !== undefined && (typeof status.sha !== 'string'
        || !SHA_RE.test(status.sha) || status.sha.toLowerCase() !== headSha.toLowerCase())) {
      return { ok: false, error: 'commit statusのHEADが対象と一致しません' };
    }
    const timestamp = typeof status.created_at === 'string' ? Date.parse(status.created_at) : 0;
    const time = Number.isFinite(timestamp) ? timestamp : 0;
    const previous = latest.get(status.context);
    if (previous && previous.time >= time) continue;
    latest.set(status.context, {
      time,
      check: {
        kind: 'commit_status',
        name: status.context,
        state: mapCommitStatusState(status.state),
        detailsUrl: getDetailsUrl(status.target_url, `https://github.com/${repo}/commit/${headSha}/checks`),
      },
    });
  }
  return { ok: true, checks: [...latest.values()].map(({ check }) => check) };
}

function commandResult(result, label) {
  if (!result || result.error || result.status !== 0) {
    const detail = result && result.error && result.error.message
      ? result.error.message : (result && result.stderr) || '(no stderr)';
    return { ok: false, error: `${label}の取得に失敗しました: ${detail}` };
  }
  return { ok: true, stdout: result.stdout || '' };
}

function readHead(readPrHeadFn, prNumber, repo, label) {
  let result;
  try {
    result = readPrHeadFn(prNumber, repo);
  } catch (error) {
    return {
      ok: false,
      error: `${label}: ${error && error.message ? error.message : String(error)}`,
    };
  }
  if (!result || result.ok !== true || typeof result.headSha !== 'string'
      || !SHA_RE.test(result.headSha)) {
    return {
      ok: false,
      error: `${label}: ${(result && result.error) || '応答形式が不正です'}`,
    };
  }
  return result;
}

function runGhApi(ghApiFn, endpoint, label) {
  try {
    return commandResult(ghApiFn(endpoint), label);
  } catch (error) {
    return {
      ok: false,
      error: `${label}の取得に失敗しました: ${error && error.message ? error.message : String(error)}`,
    };
  }
}

/**
 * PRのHEADを両側で照合しながら、そのcommitに属するチェックを取得する。
 * @param {{pr:string|number,repo:string}} params
 * @param {{readPrHeadFn?:Function,ghApiFn?:Function}} [deps]
 */
function queryPrChecks({ pr, repo }, deps = {}) {
  const prNumber = String(pr === undefined || pr === null ? '' : pr).trim();
  if (!/^\d+$/.test(prNumber) || Number(prNumber) <= 0) {
    return { ok: false, error: `PR番号が不正です: ${pr}` };
  }
  const targetRepo = typeof repo === 'string' ? repo.trim() : '';
  if (!targetRepo) return { ok: false, error: 'リポジトリ名が空です' };

  const readPrHeadFn = deps.readPrHeadFn || readPrHead;
  const ghApiFn = deps.ghApiFn || ghApi;
  const initialHead = readHead(readPrHeadFn, prNumber, targetRepo, `PR #${prNumber} のHEADを取得できません`);
  if (!initialHead.ok) {
    return initialHead;
  }
  const headSha = initialHead.headSha;

  const checkRunResponse = runGhApi(
    ghApiFn,
    `repos/${targetRepo}/commits/${headSha}/check-runs?per_page=100`,
    'Check Runs',
  );
  if (!checkRunResponse.ok) return checkRunResponse;
  const checkRuns = parseCheckRuns(checkRunResponse.stdout, headSha, targetRepo);
  if (!checkRuns.ok) return checkRuns;

  const statusResponse = runGhApi(
    ghApiFn,
    `repos/${targetRepo}/commits/${headSha}/statuses?per_page=100`,
    'commit statuses',
  );
  if (!statusResponse.ok) return statusResponse;
  const statuses = parseCommitStatuses(statusResponse.stdout, headSha, targetRepo);
  if (!statuses.ok) return statuses;

  const latestHead = readHead(readPrHeadFn, prNumber, targetRepo, `チェック取得後のPR #${prNumber} HEADを確認できません`);
  if (!latestHead.ok) {
    return latestHead;
  }
  if (latestHead.headSha.toLowerCase() !== headSha.toLowerCase()) {
    return { ok: false, error: `チェック取得中にPR #${prNumber} のHEADが変わりました: ${headSha} -> ${latestHead.headSha}` };
  }

  const checks = [...checkRuns.checks, ...statuses.checks]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const hasChecks = checks.length > 0;
  const hasRunning = checks.some(check => check.state === 'running');
  return {
    ok: true,
    pr: prNumber,
    headSha,
    checks,
    hasChecks,
    hasRunning,
    allCompleted: hasChecks && !hasRunning,
  };
}

module.exports = {
  GH_TIMEOUT_MS,
  FAILING_CONCLUSIONS,
  RUNNING_CHECK_STATUSES,
  ghApi,
  parseCheckRuns,
  parseCommitStatuses,
  mapCheckRunState,
  mapCommitStatusState,
  queryPrChecks,
};
