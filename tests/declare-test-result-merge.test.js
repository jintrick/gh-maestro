'use strict';

// 申告コメントの層別合成（Issue #664）。gh は「コメントの保存領域」を持つ状態付きスタブで
// 差し替え、本文は実際の buildCommentBody が作る。合成・評価の判定そのものは差し替えない。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { declareTestResult } = require('../scripts/declare-test-result');
const { queryTestStatus } = require('../scripts/query-test-status');
const {
  TEST_RESULT_MARKER,
  evaluateTestDeclaration,
  extractTestDeclaration,
  mergeAggregateDeclarationBodies,
} = require('../scripts/shared/test-declaration');

const SHA = 'a1b2c3d4e5f67890123456789012345678901234';
const OTHER_SHA = 'b1b2c3d4e5f67890123456789012345678901234';
const HASH = 'a'.repeat(64);

const fullLayer = (extra = {}) => ({
  layer: 'full', scope: 'full', status: 'complete', outcome: 'pass', tests: 2671, pass: 2671, fail: 0,
  executor: 'test-runner', testedContentHash: HASH, ...extra,
});
const slowLayer = (extra = {}) => ({
  layer: 'slow', scope: 'partial', status: 'complete', outcome: 'pass', tests: 3, pass: 3, fail: 0,
  executor: 'poll-pr', testedContentHash: HASH, ...extra,
});
const LINT_PASS = { status: 'complete', outcome: 'pass', findingCount: 0, testedContentHash: HASH };

function aggregate(layers, lint) {
  return { provenance: 'test-runner', scope: 'aggregate', layers, ...(lint ? { lint } : {}) };
}

// コメントの保存領域を持つ gh スタブ。PATCH は本文を実際に置換する。
function ghStore(initialBodies = []) {
  const comments = initialBodies.map((body, i) => ({
    id: 100 + i, body, html_url: `https://example.test/c/${100 + i}`,
    author: { login: 'owner' }, authorAssociation: 'OWNER',
  }));
  return {
    comments,
    deps: {
      ghListCommentsFn: () => ({ status: 0, stdout: JSON.stringify(comments), stderr: '' }),
      ghCreateCommentFn: (_pr, _repo, body) => {
        const id = 100 + comments.length;
        comments.push({ id, body, html_url: `https://example.test/c/${id}`, author: { login: 'owner' }, authorAssociation: 'OWNER' });
        return { status: 0, stdout: JSON.stringify({ html_url: `https://example.test/c/${id}` }), stderr: '' };
      },
      ghUpdateCommentFn: (id, _repo, body) => {
        comments.find(c => c.id === id).body = body;
        return { status: 0, stdout: JSON.stringify({ html_url: `https://example.test/c/${id}` }), stderr: '' };
      },
    },
  };
}

function declare(store, artifact, headSha = SHA, extraDeps = {}) {
  return declareTestResult(
    { pr: '7', repo: 'owner/repo', headSha },
    {
      gitHeadFn: () => headSha,
      readTestResultFn: () => ({ ok: true, result: artifact }),
      commitContentHashFn: () => HASH,
      ...store.deps,
      ...extraDeps,
    },
  );
}

function status(store, headSha = SHA) {
  return queryTestStatus({ pr: '7', repo: 'owner/repo' }, {
    ghPrViewFn: () => ({
      status: 0,
      stdout: JSON.stringify({
        comments: store.comments.map(c => ({ body: c.body, author: c.author, authorAssociation: c.authorAssociation })),
        headRefOid: headSha,
        author: { login: 'owner' },
      }),
      stderr: '',
    }),
  });
}

// ── AC1: full 申告のあとに slow を申告しても full と lint が残る ──────────────

for (const [label, slow, shown] of [
  ['pass', slowLayer(), 'pass'],
  ['fail', slowLayer({ outcome: 'fail', pass: 2, fail: 1, failedTests: ['slow case'] }), 'fail'],
  ['unavailable', slowLayer({ status: 'unavailable', outcome: undefined, reason: 'worktree-missing' }), 'unknown'],
]) {
  test(`AC1: full 申告後の slow(${label}) 申告で full の件数と lint が残る`, () => {
    const store = ghStore();
    assert.equal(declare(store, aggregate({ full: fullLayer() }, LINT_PASS)).ok, true);
    // slow 側の worktree には lint の成果物が無い（missing）
    assert.equal(declare(store, aggregate({ slow }), SHA).ok, true);

    assert.equal(store.comments.length, 1);
    const body = store.comments[0].body;
    assert.match(body, /\*\*full\*\*: pass \(fail: 0, pass: 2671\)/);
    assert.match(body, new RegExp(`\\*\\*slow\\*\\*: ${shown}`));
    assert.match(body, /- \*\*lint\*\*: pass/);
    const q = status(store);
    assert.equal(q.ok, true);
    if (label === 'unavailable') {
      // 結果行が unknown の申告は従来どおり query に layers を出さず NONE になる。
      // 本文には full の件数と lint が残っており、GREEN にもならない。
      const declaration = extractTestDeclaration(body);
      assert.deepEqual(Object.keys(declaration.layers), ['full', 'slow']);
      assert.equal(declaration.lint.status, 'complete');
      assert.equal(q.status, 'NONE');
      return;
    }
    assert.deepEqual(Object.keys(q.layers), ['full', 'slow']);
    assert.equal(q.layers.full.pass, 2671);
    assert.equal(q.lint.status, 'complete');
    assert.equal(q.allLayersPresent, true);
    assert.equal(q.status, label === 'pass' ? 'GREEN' : 'RED');
  });
}
test('AC1: slow の層行（失敗テスト名）は合成後も原文のまま保たれる', () => {
  const store = ghStore();
  declare(store, aggregate({ slow: slowLayer({ outcome: 'fail', pass: 2, fail: 1, failedTests: ['t1', 't2'] }) }));
  const slowLine = store.comments[0].body.split('\n').find(l => l.includes('**slow**'));
  assert.match(slowLine, /失敗: `t1`, `t2`/);
  declare(store, aggregate({ full: fullLayer() }, LINT_PASS));
  assert.ok(store.comments[0].body.split('\n').includes(slowLine));
});

// ── AC2: slow 先 → full 後 ──────────────────────────────────────────────────

test('AC2: slow 先に申告され full が後から来ても両層が残り、lint は full 側の実測が入る', () => {
  const store = ghStore();
  declare(store, aggregate({ slow: slowLayer() }));
  declare(store, aggregate({ full: fullLayer() }, LINT_PASS));
  const q = status(store);
  assert.deepEqual(Object.keys(q.layers), ['full', 'slow']);
  assert.equal(q.status, 'GREEN');
  assert.equal(q.lint.status, 'complete');
});

// ── AC3: full fail + slow pass は RED ───────────────────────────────────────

test('AC3: full fail の後に slow pass を申告しても RED のまま', () => {
  const store = ghStore();
  declare(store, aggregate({ full: fullLayer({ outcome: 'fail', pass: 2670, fail: 1 }) }, LINT_PASS));
  declare(store, aggregate({ slow: slowLayer() }));
  assert.match(store.comments[0].body, /- \*\*結果\*\*: fail/);
  assert.equal(status(store).status, 'RED');
});

test('AC3: 結果行が pass のまま層に fail がある壊れた旧コメントも RED（evaluate 直接）', () => {
  const body = [
    TEST_RESULT_MARKER,
    `- **対象コミット**: \`${SHA}\``,
    '- **結果**: pass',
    '- **実行元**: `test-runner`',
    '- **実行範囲**: `aggregate`',
    '- **lint**: pass',
    '- **層別結果**:',
    '  - **full**: fail (fail: 1, pass: 9), tests: 10',
    '  - **slow**: pass (fail: 0, pass: 3), tests: 3',
  ].join('\n');
  const declaration = extractTestDeclaration(body);
  assert.equal(declaration.outcome, 'pass');
  assert.equal(evaluateTestDeclaration(declaration, SHA).status, 'RED');
});

// ── 拒否側 ──────────────────────────────────────────────────────────────────

test('別コミットの既存コメントの層は持ち越さず置換する', () => {
  const store = ghStore();
  declare(store, aggregate({ full: fullLayer() }, LINT_PASS), OTHER_SHA);
  declare(store, aggregate({ slow: slowLayer() }), SHA);
  const body = store.comments[0].body;
  assert.ok(!body.includes('**full**'));
  assert.match(body, new RegExp(SHA));
});

for (const [label, existing] of [
  ['v1 形式', '<!-- gh-maestro-test-result:v1 -->\n- **対象コミット**: `a1b2c3d`\n- **結果**: fail (fail: 1)'],
  ['層行なしの壊れた v2', `${TEST_RESULT_MARKER}\n- **対象コミット**: \`${SHA}\`\n- **結果**: pass\n- **実行範囲**: \`aggregate\``],
  ['コミット行なしの v2', `${TEST_RESULT_MARKER}\n- **結果**: pass\n  - **full**: pass (fail: 0, pass: 1)`],
  ['unknown 範囲の v2', `${TEST_RESULT_MARKER}\n- **対象コミット**: \`${SHA}\`\n- **結果**: unknown\n- **実行元**: \`unknown\`\n- **実行範囲**: \`unknown\``],
]) {
  test(`既存コメントが ${label} でも例外にならず新しい本文で置換する`, () => {
    const store = ghStore([existing]);
    const result = declare(store, aggregate({ slow: slowLayer() }));
    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.match(store.comments[0].body, /\*\*slow\*\*: pass/);
    assert.ok(!store.comments[0].body.includes('**full**'));
  });
}

test('lint が実測 complete の新申告は既存 lint を上書きする', () => {
  const store = ghStore();
  declare(store, aggregate({ full: fullLayer() }, LINT_PASS));
  declare(store, aggregate({ full: fullLayer() }, { status: 'complete', outcome: 'findings', findingCount: 4, testedContentHash: HASH }));
  assert.match(store.comments[0].body, /- \*\*lint\*\*: findings \(findings: 4\)/);
});

test('同じ層の再実行は新が勝ち、結果行も再計算される', () => {
  const store = ghStore();
  declare(store, aggregate({ full: fullLayer({ outcome: 'fail', pass: 2670, fail: 1 }) }, LINT_PASS));
  declare(store, aggregate({ full: fullLayer() }, LINT_PASS));
  assert.match(store.comments[0].body, /- \*\*結果\*\*: pass/);
  assert.match(store.comments[0].body, /\*\*full\*\*: pass \(fail: 0, pass: 2671\)/);
});

test('PATCH 後の読み直しで引き継いだ層が欠落していたら ok:false（再試行しない）', () => {
  const store = ghStore();
  declare(store, aggregate({ full: fullLayer() }, LINT_PASS));
  let listCalls = 0;
  let updates = 0;
  const raced = declare(store, aggregate({ slow: slowLayer() }), SHA, {
    ghUpdateCommentFn: (id, repo, body) => { updates += 1; return store.deps.ghUpdateCommentFn(id, repo, body); },
    ghListCommentsFn: () => {
      listCalls += 1;
      // 1回目（更新前）は通常、2回目（検証）では別の書き手が full 層を消した本文を返す
      if (listCalls === 1) return store.deps.ghListCommentsFn();
      const stripped = store.comments.map(c => ({ ...c, body: c.body.split('\n').filter(l => !l.includes('**full**')).join('\n') }));
      return { status: 0, stdout: JSON.stringify(stripped), stderr: '' };
    },
  });
  assert.equal(raced.ok, false);
  assert.match(raced.error, /層が欠落/);
  assert.match(raced.error, /full/);
  assert.equal(updates, 1);
  assert.equal(listCalls, 2);
});

test('PATCH 後の読み直しに失敗した場合も検証できないとして ok:false', () => {
  const store = ghStore();
  declare(store, aggregate({ full: fullLayer() }, LINT_PASS));
  let listCalls = 0;
  const result = declare(store, aggregate({ slow: slowLayer() }), SHA, {
    ghListCommentsFn: () => {
      listCalls += 1;
      return listCalls === 1 ? store.deps.ghListCommentsFn() : { status: 1, stdout: '', stderr: 'boom' };
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /層が欠落/);
});

// ── mergeAggregateDeclarationBodies 単体 ────────────────────────────────────

test('mergeAggregateDeclarationBodies: 合成できない入力は newBody をそのまま返す', () => {
  assert.equal(mergeAggregateDeclarationBodies(undefined, 'new'), 'new');
  assert.equal(mergeAggregateDeclarationBodies('plain', 'new'), 'new');
});
