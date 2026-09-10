const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { cleanSpawnEnv } = require('../_spawn-env');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'finalize-review.js');

const {
  checkCompleteness,
  aggregateFindings,
  buildIncompleteComment,
  writeSentinel,
  finalizeReview,
  _setGhForTest,
} = require('../../scripts/finalize-review');

const { ALL_LEAF_IDS, TRUNK_TO_LEAVES } = require('../../scripts/shared/review-aspects');
const { _validateAgainstSchema } = require('../../scripts/shared/json-schema');

test('CLI: --help は exit 0、用途エラーは exit 1', () => {
  const help = spawnSync(process.execPath, [SCRIPT, '--help'], {
    encoding: 'utf8',
    env: cleanSpawnEnv(),
  });
  assert.equal(help.status, 0, `--help は exit 0: ${help.stderr}`);
  assert.match(help.stdout, /finalize-review\.js/);

  const missing = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: cleanSpawnEnv(),
  });
  assert.equal(missing.status, 1, `引数不足は exit 1: ${missing.stderr}`);
  assert.match(missing.stderr, /finalize-review\.js/);

  const invalidMode = spawnSync(process.execPath, [SCRIPT, '--results', 'results.json', '--mode', 'invalid'], {
    encoding: 'utf8',
    env: cleanSpawnEnv(),
  });
  assert.equal(invalidMode.status, 1, `--mode 不正は exit 1: ${invalidMode.stderr}`);
  assert.match(invalidMode.stderr, /--mode must be/);
});

test('CLI: --workspace省略時は環境変数のメインworkspaceへセンチネルを書き、CWDのreview worktreeへ書かない', () => {
  const mainWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-cli-main-'));
  const reviewWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-cli-review-'));
  try {
    const resultsPath = path.join(reviewWorktree, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify({
      manifest_ref: { pr: 438, repo: 'o/r', headRefOid: 'abc' },
      coverage_ledger: { leaves: [] },
      jobs: [],
    }), 'utf8');

    const env = cleanSpawnEnv();
    env.GH_MAESTRO_WORKSPACE = mainWorkspace;
    const result = spawnSync(process.execPath, [
      SCRIPT, '--results', resultsPath, '--mode', 'incomplete',
    ], {
      cwd: reviewWorktree,
      env,
      encoding: 'utf8',
    });

    // NODE_TEST_CONTEXT による投稿拒否は想定内だが、センチネルの配置は完了する。
    assert.equal(result.status, 1, `投稿拒否以外で失敗していないこと: ${result.stderr}`);
    const mainSentinel = path.join(mainWorkspace, '.gh-maestro', 'records', 'pr', '438', 'review', 'manager.incomplete');
    const reviewSentinel = path.join(reviewWorktree, '.gh-maestro', 'records', 'pr', '438', 'review', 'manager.incomplete');
    assert.ok(fs.existsSync(mainSentinel), `メインworkspaceにセンチネルが作成されること: ${mainSentinel}`);
    assert.ok(!fs.existsSync(reviewSentinel), 'CWDのreview worktreeにはセンチネルを作成しない');
  } finally {
    fs.rmSync(mainWorkspace, { recursive: true, force: true });
    fs.rmSync(reviewWorktree, { recursive: true, force: true });
  }
});














// ── finalizeReview(complete) with --integrated（RMフェーズ2の重複統合ドラフト） ──

function completeGateResults() {
  return {
    manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
    coverage_ledger: {
      leaves: ALL_LEAF_IDS.map(id => ({
        id,
        trunk: Object.entries(TRUNK_TO_LEAVES).find(([, lvs]) => lvs.includes(id))[0],
        decision: 'adopted',
        rationale: null,
      })),
    },
    jobs: ALL_LEAF_IDS.map((id, i) => ({
      id: 'job-' + i,
      status: 'success',
      leaf_ids: [id],
      findings: [],
    })),
  };
}
