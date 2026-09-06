'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidCommentId,
  isValidPrCommentId,
  buildPrCommentRelayEvents,
  formatTestStatusEvent,
} = require('../../scripts/poll-reviews.js');






const { pollDegradationTransition } = require('../../scripts/poll-reviews.js');



// ── reviewTerminalEvent（Issue #289: CLOSED も終端として扱う） ──────────────
const { reviewTerminalEvent } = require('../../scripts/poll-reviews.js');




// ── extractTestDeclaration & evaluateTestDeclaration ────────────────────────
const { extractTestDeclaration, evaluateTestDeclaration } = require('../../scripts/poll-reviews.js');
const { TEST_RESULT_MARKER, LEGACY_TEST_RESULT_MARKER } = require('../../scripts/shared/test-declaration');

function fullDeclarationBody(commit = 'a1b2c3d4e5', fail = 0, pass = 1826, scope = 'full') {
  return `${TEST_RESULT_MARKER}
### 🧪 テスト結果申告
- **対象コミット**: \`${commit}\`
- **結果**: ${fail === 0 ? 'pass' : 'fail'} (fail: ${fail}, pass: ${pass})
- **実行件数**: \`${fail + pass}\`
- **実行元**: \`test-runner\`
- **実行範囲**: \`${scope}\``;
}












// ── CLI: workspace 解決（サブプロセス経由） ─────────────────────────────────
// workspace 解決は gh 呼び出しより前に行われるため、この検証だけなら実 gh 呼び出しは発生しない。

test('[WORKSPACE] 位置引数がホームディレクトリと衝突する場合、生の例外ではなくワークスペース解決エラーで exit 1 する（Issue #214）', () => {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-fakehome-'));
  try {
    const script = path.join(__dirname, '..', '..', 'scripts', 'poll-reviews.js');
    const envKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const env = { ...process.env, [envKey]: fakeHome };
    delete env.GH_MAESTRO_WORKSPACE;

    const r = spawnSync(process.execPath, [script, '999', fakeHome], { encoding: 'utf8', timeout: 10000, env });

    assert.equal(r.status, 1);
    assert.match(r.stderr, /ワークスペースを解決できません/);
    assert.doesNotMatch(r.stderr, /assertValidWorkspace/, `生の例外スタックトレースが漏れてはならない: ${r.stderr}`);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
