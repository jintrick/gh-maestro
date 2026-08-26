'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { buildSyncedClaudeMd, BEGIN, END } = require('../scripts/sync-agents-md');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'sync-agents-md.js');

function withProject(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-sync-agents-test-'));
  const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    return fn(base);
  } finally {
    if (savedWorkspace !== undefined) process.env.GH_MAESTRO_WORKSPACE = savedWorkspace;
    else delete process.env.GH_MAESTRO_WORKSPACE;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function withGitWorkspace(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-sync-agents-git-'));
  const savedWorkspace = process.env.GH_MAESTRO_WORKSPACE;
  delete process.env.GH_MAESTRO_WORKSPACE;
  try {
    const git = (...args) => {
      const env = { ...process.env };
      delete env.GH_MAESTRO_WORKSPACE;
      const r = spawnSync('git', args, { cwd: base, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };
    git('init', '-q');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'test');
    fs.mkdirSync(path.join(base, '.gh-maestro'), { recursive: true });
    fs.writeFileSync(path.join(base, 'README.md'), 'init');
    git('add', 'README.md');
    git('commit', '-qm', 'init');
    return fn(base);
  } finally {
    if (savedWorkspace !== undefined) process.env.GH_MAESTRO_WORKSPACE = savedWorkspace;
    else delete process.env.GH_MAESTRO_WORKSPACE;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function runScript(cwd) {
  const env = { ...process.env };
  delete env.GH_MAESTRO_WORKSPACE;
  return spawnSync(process.execPath, [SCRIPT], { cwd, env, encoding: 'utf8' });
}

// ── buildSyncedClaudeMd ────────────────────────────────────────────────────────

test('buildSyncedClaudeMd: マーカー間をAGENTS.mdの内容で置き換える', () => {
  const claude = `# CLAUDE\n\n${BEGIN}\nold content\n${END}\n\nfooter`;
  const result = buildSyncedClaudeMd(claude, 'new agents content');
  assert.ok(result.includes('new agents content'));
  assert.ok(!result.includes('old content'));
  assert.ok(result.includes('footer'));
});

test('buildSyncedClaudeMd: マーカーがなければエラーを投げる', () => {
  assert.throws(() => buildSyncedClaudeMd('# CLAUDE\n\nno markers here', 'agents'), /マーカー/);
});

// ── --help ───────────────────────────────────────────────────────────────────

test('syncAgentsMd: --help は終了コード0でusageを表示する', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node sync-agents-md\.js/);
});

// ── syncAgentsMd (integration) ─────────────────────────────────────────────────

test('syncAgentsMd: AGENTS.md を CLAUDE.md のマーカー間に同期する', () => {
  withProject(base => {
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Agent Guide\n\nsome rule');
    fs.writeFileSync(path.join(base, 'CLAUDE.md'),
      `# CLAUDE\n\n${BEGIN}\n${END}\n\nfooter`);

    const r = runScript(base);
    assert.equal(r.status, 0, r.stderr);

    const out = fs.readFileSync(path.join(base, 'CLAUDE.md'), 'utf8');
    assert.ok(out.includes('some rule'));
  });
});

test('syncAgentsMd: AGENTS.md がなければエラー終了する', () => {
  withProject(base => {
    fs.writeFileSync(path.join(base, 'CLAUDE.md'), `# CLAUDE\n\n${BEGIN}\n${END}`);
    const r = runScript(base);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AGENTS\.md/);
  });
});

test('syncAgentsMd: workspace未解決時は stderr に警告を出力する', () => {
  withProject(base => {
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: base,
      env: { ...process.env, GH_MAESTRO_WORKSPACE: os.homedir() },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /同期失敗の記録に失敗しました/);
  });
});

test('syncAgentsMd: 同期失敗時に .gh-maestro/sync-failures/sync-agents-md.yaml を作成し、timestamp・error・head を記録する', () => {
  withGitWorkspace(base => {
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Agent Guide');
    fs.writeFileSync(path.join(base, 'CLAUDE.md'), '# CLAUDE\n\nno markers');

    const r = runScript(base);
    assert.notEqual(r.status, 0);

    const failureFile = path.join(base, '.gh-maestro', 'sync-failures', 'sync-agents-md.yaml');
    assert.ok(fs.existsSync(failureFile), 'sync-agents-md.yaml が生成されていること');
    const content = fs.readFileSync(failureFile, 'utf8');
    assert.match(content, /^timestamp:\s*\d{4}-\d{2}-\d{2}T/m);
    assert.match(content, /^error:\s*".*マーカー.*"/m);
    assert.match(content, /^head:\s*[0-9a-f]{40}$/m);
  });
});

test('syncAgentsMd: 同期成功時に既存の .gh-maestro/sync-failures/sync-agents-md.yaml を削除する', () => {
  withGitWorkspace(base => {
    const failureDir = path.join(base, '.gh-maestro', 'sync-failures');
    fs.mkdirSync(failureDir, { recursive: true });
    const failureFile = path.join(failureDir, 'sync-agents-md.yaml');
    fs.writeFileSync(failureFile, 'stale failure', 'utf8');

    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Agent Guide\n\ncontent');
    fs.writeFileSync(path.join(base, 'CLAUDE.md'), `# CLAUDE\n\n${BEGIN}\n${END}\n\nfooter`);

    const r = runScript(base);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(failureFile), '同期成功後に sync-agents-md.yaml が削除されていること');
  });
});

test('syncAgentsMd: fs例外（CLAUDE.md書き込み失敗等）でも recordSyncFailure が呼ばれて記録が残る', () => {
  withGitWorkspace(base => {
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Agent Guide\n\nrule');
    // CLAUDE.md をディレクトリとして作成しておくことで writeFileSync が EISDIR / EPERM で失敗する
    fs.mkdirSync(path.join(base, 'CLAUDE.md'));

    const r = runScript(base);
    assert.notEqual(r.status, 0);

    const failureFile = path.join(base, '.gh-maestro', 'sync-failures', 'sync-agents-md.yaml');
    assert.ok(fs.existsSync(failureFile), 'fs例外時にも sync-agents-md.yaml が生成されていること');
    const content = fs.readFileSync(failureFile, 'utf8');
    assert.match(content, /^error:\s*".*"/m);
  });
});

test('pre-commit フック経由: 同期失敗してもコミットは成立し、sync-agents-md.yaml が生成される', () => {
  withGitWorkspace(base => {
    // フック配置（.githooks/pre-commit 相当）
    const hooksDir = path.join(base, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommitHook = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(preCommitHook, [
      '#!/bin/sh',
      `node "${SCRIPT.split(path.sep).join('/')}" || true`,
      'git add CLAUDE.md 2>/dev/null || true',
    ].join('\n'), 'utf8');
    try { fs.chmodSync(preCommitHook, 0o755); } catch {}

    // マーカー不在の CLAUDE.md と AGENTS.md
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# Updated AGENTS');
    fs.writeFileSync(path.join(base, 'CLAUDE.md'), '# Broken CLAUDE with no markers');

    const env = { ...process.env };
    delete env.GH_MAESTRO_WORKSPACE;
    const git = (...args) => spawnSync('git', args, { cwd: base, env, encoding: 'utf8' });
    git('add', 'AGENTS.md');
    const commitRes = git('commit', '-m', 'test sync failure commit');

    // コミットは成立する
    assert.equal(commitRes.status, 0, `コミットが失敗した: ${commitRes.stderr}`);

    // sync-agents-md.yaml が生成されていること
    const failureFile = path.join(base, '.gh-maestro', 'sync-failures', 'sync-agents-md.yaml');
    assert.ok(fs.existsSync(failureFile), 'コミット成立後も sync-agents-md.yaml が生成されていること');
  });
});

test('pre-commit フック経由: CLAUDE.md 不在時でも git add CLAUDE.md で止まらずコミットが成立する', () => {
  withGitWorkspace(base => {
    const hooksDir = path.join(base, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommitHook = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(preCommitHook, [
      '#!/bin/sh',
      `node "${SCRIPT.split(path.sep).join('/')}" || true`,
      'git add CLAUDE.md 2>/dev/null || true',
    ].join('\n'), 'utf8');
    try { fs.chmodSync(preCommitHook, 0o755); } catch {}

    // CLAUDE.md は存在しない
    fs.writeFileSync(path.join(base, 'AGENTS.md'), '# AGENTS only');

    const env = { ...process.env };
    delete env.GH_MAESTRO_WORKSPACE;
    const git = (...args) => spawnSync('git', args, { cwd: base, env, encoding: 'utf8' });
    git('add', 'AGENTS.md');
    const commitRes = git('commit', '-m', 'commit without claude md');

    // コミットは成立する
    assert.equal(commitRes.status, 0, `CLAUDE.md不在でもコミットが成立すること: ${commitRes.stderr}`);

    // sync-agents-md.yaml が生成されていること
    const failureFile = path.join(base, '.gh-maestro', 'sync-failures', 'sync-agents-md.yaml');
    assert.ok(fs.existsSync(failureFile), 'CLAUDE.md不在の失敗が記録されていること');
  });
});
