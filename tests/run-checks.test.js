'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { detectPrecommitPlan, detectPrepushPlan, USAGE } = require('../scripts/hooks/run-checks');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'hooks', 'run-checks.js');

function withProject(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-run-checks-test-'));
  try {
    return fn(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function writePkg(dir, pkg) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
}

function runScript(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

// ── detectPrecommitPlan ───────────────────────────────────────────────────────

test('detectPrecommitPlan: package.jsonが無ければnull', () => {
  withProject((dir) => {
    assert.equal(detectPrecommitPlan(dir), null);
  });
});

test('detectPrecommitPlan: package.jsonが壊れていればnull（fail-open）', () => {
  withProject((dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json', 'utf8');
    assert.equal(detectPrecommitPlan(dir), null);
  });
});

test('detectPrecommitPlan: lint-stagedキーが無ければnull', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { lint: 'eslint .' } });
    assert.equal(detectPrecommitPlan(dir), null);
  });
});

test('detectPrecommitPlan: package.jsonにlint-stagedキーがあればnpx lint-stagedを返す', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', 'lint-staged': { '*.js': 'eslint' } });
    assert.deepEqual(detectPrecommitPlan(dir), { cmd: 'npx', args: ['--no-install', 'lint-staged'] });
  });
});

test('detectPrecommitPlan: .lintstagedrc.json単体でも検出する', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x' });
    fs.writeFileSync(path.join(dir, '.lintstagedrc.json'), '{}', 'utf8');
    assert.deepEqual(detectPrecommitPlan(dir), { cmd: 'npx', args: ['--no-install', 'lint-staged'] });
  });
});

// ── detectPrepushPlan ─────────────────────────────────────────────────────────

test('detectPrepushPlan: package.jsonが無ければ空配列', () => {
  withProject((dir) => {
    assert.deepEqual(detectPrepushPlan(dir), []);
  });
});

test('detectPrepushPlan: testスクリプトのみあればtestだけ実行計画に含む', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { test: 'node --test' } });
    assert.deepEqual(detectPrepushPlan(dir), [{ cmd: 'npm', args: ['test'], label: 'test' }]);
  });
});

test('detectPrepushPlan: typecheckスクリプトがあれば含む', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { typecheck: 'tsc --noEmit' } });
    assert.deepEqual(detectPrepushPlan(dir), [{ cmd: 'npm', args: ['run', 'typecheck'], label: 'typecheck' }]);
  });
});

test('detectPrepushPlan: type-check（ハイフン区切り）も検出する', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { 'type-check': 'tsc --noEmit' } });
    assert.deepEqual(detectPrepushPlan(dir), [{ cmd: 'npm', args: ['run', 'type-check'], label: 'type-check' }]);
  });
});

test('detectPrepushPlan: typecheckとtype-check両方あればtypecheckを優先する', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { typecheck: 'a', 'type-check': 'b' } });
    const plan = detectPrepushPlan(dir);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].label, 'typecheck');
  });
});

test('detectPrepushPlan: test/typecheck両方あれば両方とも実行計画に含む', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { test: 'a', typecheck: 'b' } });
    const plan = detectPrepushPlan(dir);
    assert.deepEqual(plan.map(p => p.label), ['test', 'typecheck']);
  });
});

// ── CLI統合 ───────────────────────────────────────────────────────────────────

test('--help はUsageを表示して終了コード0', () => {
  const r = runScript(['--help'], __dirname);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('Usage:'));
});

test('引数なしはUsageエラーで終了コード1', () => {
  const r = runScript([], __dirname);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes(USAGE.split('\n')[0]));
});

test('不正なstage引数はUsageエラーで終了コード1', () => {
  const r = runScript(['bogus-stage'], __dirname);
  assert.equal(r.status, 1);
});

test('位置引数が3個以上あるとUsageエラー（誤用検知）', () => {
  const r = runScript(['precommit', '.', 'extra'], __dirname);
  assert.equal(r.status, 1);
});

test('precommit: package.json無しのプロジェクトではskipしてexit 0', () => {
  withProject((dir) => {
    const r = runScript(['precommit', dir], dir);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('スキップ'));
  });
});

test('prepush: testスクリプトが失敗コマンドならexit 1が伝播する', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { test: 'node -e "process.exit(1)"' } });
    const r = runScript(['prepush', dir], dir);
    assert.equal(r.status, 1);
  });
});

test('prepush: testスクリプトが成功コマンドならexit 0', () => {
  withProject((dir) => {
    writePkg(dir, { name: 'x', scripts: { test: 'node -e "process.exit(0)"' } });
    const r = runScript(['prepush', dir], dir);
    assert.equal(r.status, 0);
  });
});
