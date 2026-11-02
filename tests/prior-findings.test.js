'use strict';

// 再レビュー（Issue #717）: 前回の指摘ファイルの検証と、不完全レビューの公開経路での
// 「前回無視・保留した未変更の指摘」の除外。実gitリポジトリ（一時ディレクトリ）で検証する。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  loadPriorFindings, buildPriorFindingsSchema, suppressUnchangedPriorFindings,
} = require('../scripts/shared/prior-findings');
const { finalizeReview, _setGhForTest } = require('../scripts/finalize-review');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

const scope = createTempDirScope();
after(() => scope.cleanup());

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function tmp(prefix) {
  return scope.mkdtemp(prefix);
}

const FILE_V1 = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', ''].join('\n');

/** v1 をコミットし、afterV1(repoDir) で v2 を作ってコミットする。前回HEAD(v1)のSHAを返す。 */
function makeRepo(v2Text) {
  const dir = tmp('pf-repo-');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.js'), FILE_V1);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'v1');
  const priorHead = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.js'), v2Text);
  git(dir, 'commit', '-q', '--allow-empty', '-am', 'v2');
  return { dir, priorHead };
}

function finding(overrides = {}) {
  return {
    aspect: 'Correctness', path: 'a.js', line_anchor: 'line2', summary: 's', severity: 'MAJOR',
    severity_rationale: 'r', body: 'b', verified_references: ['a.js:2'], ...overrides,
  };
}

function writePrior(dir, priorHead, findings) {
  const file = path.join(dir, 'prior-findings.json');
  fs.writeFileSync(file, JSON.stringify({ pr: 5, repo: 'o/r', headRefOid: priorHead, findings }));
  return file;
}

// ── スキーマ: review-findings-schema.json が正本であること ───────────────────

test('前回の指摘のスキーマは review-findings-schema.json の定義に disposition を足しただけ', () => {
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'review-findings-schema.json'), 'utf8'));
  const derived = buildPriorFindingsSchema();
  const bi = base.properties.findings.items;
  const di = derived.properties.findings.items;
  assert.deepEqual(di.required, [...bi.required, 'disposition']);
  assert.deepEqual(Object.keys(di.properties), [...Object.keys(bi.properties), 'disposition']);
  for (const k of Object.keys(bi.properties)) assert.deepEqual(di.properties[k], bi.properties[k]);
  assert.deepEqual(di.properties.disposition.enum, ['fixed', 'ignored', 'deferred']);
});

test('manager.json の finding に disposition を足したものは受理され、足さないものは拒否される', () => {
  const dir = tmp('pf-schema-');
  const ok = writePrior(dir, 'abc1234', [finding({ disposition: 'ignored' })]);
  assert.doesNotThrow(() => loadPriorFindings(ok));
  const bad = writePrior(dir, 'abc1234', [finding()]);
  assert.throws(() => loadPriorFindings(bad), /disposition/);
});

// ── 除外: 前回HEAD→現在HEADの差分で、該当箇所が未変更のものだけを除く ─────────

test('無視・保留した指摘は、該当箇所が前回HEADから変わっていなければ除外し、変わっていれば残す', () => {
  // v2: line5 だけを書き換える（line2 は未変更、line5 は変更）
  const v2 = FILE_V1.replace('line5', 'line5-edited');
  const { dir, priorHead } = makeRepo(v2);
  const prior = writePrior(dir, priorHead, [
    finding({ line_anchor: 'line2', disposition: 'ignored' }),
    finding({ line_anchor: 'line5', disposition: 'deferred' }),
  ]);
  const unchanged = finding({ line_anchor: 'line2', summary: 'unchanged' });
  const changed = finding({ line_anchor: 'line5', summary: 'changed' });
  const r = suppressUnchangedPriorFindings([unchanged, changed], prior, { cwd: dir });
  assert.deepEqual(r.findings.map(f => f.summary), ['changed']);
  assert.equal(r.suppressedCount, 1);
  assert.equal(r.unavailable, null);
});

test('前回から触っていない行は、PR全体で見れば新規でも、前回HEADからの差分で未変更と判定される（PR全体diffでは判定しない）', () => {
  // 先頭に3行追加しても、line2 の中身は変わらない。差分は前回HEAD(v1)基準なので、
  // 行番号が動いても line2 は「変わっていない」。挿入位置は line2 の外（先頭の前）。
  const v2 = ['new1', 'new2', 'new3', FILE_V1].join('\n');
  const { dir, priorHead } = makeRepo(v2);
  const prior = writePrior(dir, priorHead, [finding({ line_anchor: 'line2', disposition: 'ignored' })]);
  const r = suppressUnchangedPriorFindings([finding({ line_anchor: 'line2' })], prior, { cwd: dir });
  assert.equal(r.findings.length, 0);
  assert.equal(r.suppressedCount, 1);
});

test('複数行のアンカーは、内側への挿入で変更扱い（残す）、直後への追加は未変更（除外）', () => {
  const anchor = 'line2\nline3';
  const inside = makeRepo(FILE_V1.replace('line2\nline3', 'line2\nINSERTED\nline3'));
  const priorInside = writePrior(inside.dir, inside.priorHead, [finding({ line_anchor: anchor, disposition: 'ignored' })]);
  const rIn = suppressUnchangedPriorFindings([finding({ line_anchor: anchor })], priorInside, { cwd: inside.dir });
  assert.equal(rIn.findings.length, 1, '内側に行が挿入されたので出し直しを許す');

  const after = makeRepo(FILE_V1.replace('line3\n', 'line3\nAPPENDED\n'));
  const priorAfter = writePrior(after.dir, after.priorHead, [finding({ line_anchor: anchor, disposition: 'ignored' })]);
  const rAf = suppressUnchangedPriorFindings([finding({ line_anchor: anchor })], priorAfter, { cwd: after.dir });
  assert.equal(rAf.findings.length, 0, 'アンカーの直後への追加はアンカー自体を変えない');
});

test('fixed・別ファイル・前回HEADを引けない・アンカーが前回に無い場合は、除外せず残す', () => {
  const { dir, priorHead } = makeRepo(FILE_V1.replace('line5', 'line5-edited'));
  const prior = writePrior(dir, priorHead, [
    finding({ line_anchor: 'line2', disposition: 'fixed' }),
    finding({ line_anchor: 'line3', path: 'other.js', disposition: 'ignored' }),
    finding({ line_anchor: 'not in old file', disposition: 'ignored' }),
  ]);
  const input = [
    finding({ line_anchor: 'line2', summary: 'fixed' }),
    finding({ line_anchor: 'line3', summary: 'path-differs' }),
    finding({ line_anchor: 'not in old file', summary: 'anchor-missing' }),
  ];
  const r = suppressUnchangedPriorFindings(input, prior, { cwd: dir });
  assert.deepEqual(r.findings.map(f => f.summary), ['fixed', 'path-differs', 'anchor-missing']);

  const unknownHead = writePrior(dir, 'deadbeefdeadbeef', [finding({ line_anchor: 'line2', disposition: 'ignored' })]);
  const r2 = suppressUnchangedPriorFindings([finding({ line_anchor: 'line2' })], unknownHead, { cwd: dir });
  assert.equal(r2.findings.length, 1, '前回HEADをgitが引けないときは除外しない');
});

test('前回の指摘ファイルを読めない場合（無し・JSON構文エラー・スキーマ違反）は何も除外せず、使えなかった事実を返す', () => {
  const dir = tmp('pf-unavail-');
  const input = [finding()];
  const missing = suppressUnchangedPriorFindings(input, path.join(dir, 'none.json'), { cwd: dir });
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ nope');
  const syntax = suppressUnchangedPriorFindings(input, broken, { cwd: dir });
  const schemaBad = suppressUnchangedPriorFindings(input, writePrior(dir, 'abc1234', [finding()]), { cwd: dir });
  for (const r of [missing, syntax, schemaBad]) {
    assert.equal(r.findings.length, 1);
    assert.equal(r.suppressedCount, 0);
    assert.ok(r.unavailable);
  }
});

test('指定が無ければ（null）そのまま返す', () => {
  const input = [finding()];
  assert.deepEqual(suppressUnchangedPriorFindings(input, null), { findings: input, suppressedCount: 0, unavailable: null });
});

// ── 不完全レビューの投稿に前回の扱いが適用される ─────────────────────────────

function incompleteResults(dir, findings) {
  const resultsPath = path.join(dir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify({
    manifest_ref: { pr: 5, repo: 'o/r', headRefOid: 'abc' },
    coverage_ledger: { leaves: [
      { id: 'correctness/logic-invariants', trunk: 'Correctness', decision: 'adopted', rationale: null },
      { id: 'correctness/api-contract', trunk: 'Correctness', decision: 'adopted', rationale: null },
    ] },
    jobs: [
      { id: 'job-1', status: 'success', leaf_ids: ['correctness/logic-invariants'], findings },
      { id: 'job-2', status: 'failed', leaf_ids: ['correctness/api-contract'], error: 'boom', findings: [] },
    ],
  }));
  return resultsPath;
}

async function postedIncompleteComment(resultsPath, workspace, options) {
  let body = null;
  _setGhForTest((args) => { body = args[args.indexOf('--body') + 1]; return { status: 0, stdout: 'https://x/c\n', stderr: '' }; });
  try {
    const res = await finalizeReview(resultsPath, 'incomplete', null, workspace, null, options);
    assert.equal(res.ok, true);
  } finally {
    _setGhForTest(null);
  }
  return body;
}

test('finalizeReview(incomplete): 前回の指摘を渡すと、未変更の無視済み指摘は投稿されず、変更された指摘は投稿される', async () => {
  const { dir, priorHead } = makeRepo(FILE_V1.replace('line5', 'line5-edited'));
  const prior = writePrior(dir, priorHead, [
    finding({ line_anchor: 'line2', disposition: 'ignored' }),
    finding({ line_anchor: 'line5', disposition: 'ignored' }),
  ]);
  const results = incompleteResults(dir, [
    finding({ line_anchor: 'line2', summary: 'SUMMARY-UNCHANGED' }),
    finding({ line_anchor: 'line5', summary: 'SUMMARY-CHANGED' }),
  ]);
  const body = await postedIncompleteComment(results, dir, { priorFindingsFile: prior, gitCwd: dir });
  assert.doesNotMatch(body, /SUMMARY-UNCHANGED/);
  assert.match(body, /SUMMARY-CHANGED/);
  assert.match(body, /1 件は除外しています/);
});

test('finalizeReview(incomplete): 環境変数 GH_MAESTRO_PRIOR_FINDINGS_FILE でも同じ除外が働く（RMとrun-review-jobsの子プロセス経路）', async () => {
  const { dir, priorHead } = makeRepo(FILE_V1);
  const prior = writePrior(dir, priorHead, [finding({ line_anchor: 'line2', disposition: 'deferred' })]);
  const results = incompleteResults(dir, [finding({ line_anchor: 'line2', summary: 'SUMMARY-UNCHANGED' })]);
  const saved = process.env.GH_MAESTRO_PRIOR_FINDINGS_FILE;
  process.env.GH_MAESTRO_PRIOR_FINDINGS_FILE = prior;
  const savedCwd = process.cwd();
  process.chdir(dir);
  try {
    const body = await postedIncompleteComment(results, dir, undefined);
    assert.doesNotMatch(body, /SUMMARY-UNCHANGED/);
  } finally {
    process.chdir(savedCwd);
    if (saved === undefined) delete process.env.GH_MAESTRO_PRIOR_FINDINGS_FILE; else process.env.GH_MAESTRO_PRIOR_FINDINGS_FILE = saved;
  }
});

test('finalizeReview(incomplete): 前回の指摘を渡さなければ、無視済みと同じ箇所の指摘もそのまま投稿され、除外の言及は無い（従来どおり）', async () => {
  const { dir } = makeRepo(FILE_V1);
  const results = incompleteResults(dir, [finding({ line_anchor: 'line2', summary: 'SUMMARY-UNCHANGED' })]);
  const saved = process.env.GH_MAESTRO_PRIOR_FINDINGS_FILE;
  delete process.env.GH_MAESTRO_PRIOR_FINDINGS_FILE;
  try {
    const body = await postedIncompleteComment(results, dir, undefined);
    assert.match(body, /SUMMARY-UNCHANGED/);
    assert.doesNotMatch(body, /前回/);
  } finally {
    if (saved !== undefined) process.env.GH_MAESTRO_PRIOR_FINDINGS_FILE = saved;
  }
});

test('finalizeReview(incomplete): 前回の指摘ファイルが読めなくても不完全レビューの通知は止めず、除外できなかった事実を載せる', async () => {
  const { dir } = makeRepo(FILE_V1);
  const results = incompleteResults(dir, [finding({ line_anchor: 'line2', summary: 'SUMMARY-UNCHANGED' })]);
  const body = await postedIncompleteComment(results, dir, { priorFindingsFile: path.join(dir, 'missing.json'), gitCwd: dir });
  assert.match(body, /SUMMARY-UNCHANGED/);
  assert.match(body, /前回の指摘の扱いを適用できませんでした/);
});
