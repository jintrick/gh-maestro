'use strict';

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  main,
  nextAdrPath,
  parseMarkdownHeadings,
  validateAdrBody,
  USAGE,
} = require('../scripts/create-adr');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'create-adr.js');

const VALID_BODY = [
  '# 判断を記録する',
  '',
  '## 決めたこと',
  '',
  '決定。',
  '',
  '## なぜ',
  '',
  '理由。',
  '',
  '## 却下した案',
  '',
  '検討した案。',
  '',
].join('\n');

function createWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-create-adr-'));
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'docs', 'adr'), { recursive: true });
  return workspace;
}

function cleanup(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function writeBody(workspace, body = VALID_BODY) {
  const file = path.join(workspace, 'body.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function runCli(workspace, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--workspace', workspace], {
    encoding: 'utf8',
  });
}

function writeAdr(workspace, filename, content = VALID_BODY) {
  fs.writeFileSync(path.join(workspace, 'docs', 'adr', filename), content, 'utf8');
}

test('create-adr.js: --helpと-hはworkspace解決前に終了コード0でUsageを出す', () => {
  for (const flag of ['--help', '-h']) {
    const result = spawnSync(process.execPath, [SCRIPT, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, flag);
    assert.match(result.stdout, /--next/);
    assert.match(result.stdout, /--normative-file/);
  }
});

test('create-adr.js: --nextが最大番号+1の相対パスを返し、ファイルを作らない', () => {
  const workspace = createWorkspace();
  try {
    writeAdr(workspace, '0001-first.md');
    writeAdr(workspace, '0003-third.md');
    const result = runCli(workspace, ['--next', '--slug', 'new-decision']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'ADR_NEXT:docs/adr/0004-new-decision.md');
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0004-new-decision.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 規範文書もself-containedも無い場合は作成しない', () => {
  const workspace = createWorkspace();
  try {
    const result = runCli(workspace, ['--slug', 'missing-scope', '--body-file', writeBody(workspace)]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /--normative-fileまたは--self-contained/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-missing-scope.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: self-containedは規範文書なしで作成できる', () => {
  const workspace = createWorkspace();
  try {
    const result = runCli(workspace, [
      '--slug', 'self-contained',
      '--body-file', writeBody(workspace),
      '--self-contained',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ADR_CREATED:docs/adr/0001-self-contained.md');
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 指定した規範文書が存在しなければ作成しない', () => {
  const workspace = createWorkspace();
  try {
    const result = runCli(workspace, [
      '--slug', 'missing-rule',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /指定した規範文書が存在しません/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-missing-rule.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 参照行が割り当てられたADRを指さなければ作成しない', () => {
  const workspace = createWorkspace();
  try {
    const bodyFile = writeBody(workspace);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '理由と経緯: docs/adr/0001-other.md\n', 'utf8');
    const result = runCli(workspace, [
      '--slug', 'new-decision',
      '--body-file', bodyFile,
      '--normative-file', 'AGENTS.md',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /新ADRへの参照行がありません/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-new-decision.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 規定の参照行と見出しで最大番号+1へ作成する', () => {
  const workspace = createWorkspace();
  try {
    writeAdr(workspace, '0001-first.md');
    writeAdr(workspace, '0003-third.md');
    const bodyFile = writeBody(workspace);
    fs.writeFileSync(
      path.join(workspace, 'AGENTS.md'),
      '理由と経緯: docs/adr/0004-new-decision.md\n',
      'utf8',
    );
    const result = runCli(workspace, [
      '--slug', 'new-decision',
      '--body-file', bodyFile,
      '--normative-file', 'AGENTS.md',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const created = path.join(workspace, 'docs', 'adr', '0004-new-decision.md');
    assert.equal(result.stdout.trim(), 'ADR_CREATED:docs/adr/0004-new-decision.md');
    assert.equal(fs.readFileSync(created, 'utf8'), VALID_BODY);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: コードフェンス内の見出しは規定見出しの検査対象外にする', () => {
  const body = [
    '# 判断を記録する',
    '',
    '## 決めたこと',
    '',
    '```markdown',
    '## コード中の見出し',
    '```',
    '',
    '## なぜ',
    '',
    '理由。',
    '',
    '## 却下した案',
    '',
    '案。',
  ].join('\n');
  assert.deepEqual(parseMarkdownHeadings(body).map((heading) => heading.text), [
    '判断を記録する', '決めたこと', 'なぜ', '却下した案',
  ]);
  assert.doesNotThrow(() => validateAdrBody(body));
});

test('create-adr.js: 許可されない追加見出しは作成前に拒否する', () => {
  const workspace = createWorkspace();
  try {
    const body = [VALID_BODY, '## その他', '', '追加。'].join('\n');
    const result = runCli(workspace, [
      '--slug', 'bad-headings',
      '--body-file', writeBody(workspace, body),
      '--self-contained',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /見出しはタイトルと3つの規定見出し/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-bad-headings.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: supersedesは旧ADRへの追記不足で作成しない', () => {
  const workspace = createWorkspace();
  try {
    const old = 'docs/adr/0001-old.md';
    writeAdr(workspace, '0001-old.md');
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '理由と経緯: docs/adr/0002-new.md\n', 'utf8');
    const result = runCli(workspace, [
      '--slug', 'new',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
      '--supersedes', old,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /旧ADRの覆し追記がありません/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0002-new.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: supersedesは旧ADR参照の張り替え漏れで作成しない', () => {
  const workspace = createWorkspace();
  try {
    const old = 'docs/adr/0001-old.md';
    writeAdr(workspace, '0001-old.md', [
      '# 旧判断',
      '',
      'この判断は `docs/adr/0002-new.md` で覆された',
      '',
      '## 決めたこと',
      '',
      '決定。',
      '',
      '## なぜ',
      '',
      '理由。',
      '',
      '## 却下した案',
      '',
      '案。',
    ].join('\n'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), [
      '理由と経緯: docs/adr/0002-new.md',
      '理由と経緯: docs/adr/0001-old.md',
      '',
    ].join('\n'), 'utf8');
    const result = runCli(workspace, [
      '--slug', 'new',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
      '--supersedes', old,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /旧ADRを参照したままです/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0002-new.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: supersedesは追記と参照張り替えが済んでいれば作成する', () => {
  const workspace = createWorkspace();
  try {
    const old = 'docs/adr/0001-old.md';
    writeAdr(workspace, '0001-old.md', [
      '# 旧判断',
      '',
      'この判断は `docs/adr/0002-new.md` で覆された',
      '',
      '## 決めたこと',
      '',
      '決定。',
      '',
      '## なぜ',
      '',
      '理由。',
      '',
      '## 却下した案',
      '',
      '案。',
    ].join('\n'));
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '理由と経緯: docs/adr/0002-new.md\n', 'utf8');
    const result = runCli(workspace, [
      '--slug', 'new',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
      '--supersedes', old,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0002-new.md')), true);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: mainは一時workspaceで入力エラーを返す', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-not-workspace-'));
  try {
    const result = main([
      '--slug', 'x',
      '--body-file', 'missing.md',
      '--self-contained',
      '--workspace', workspace,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ADRディレクトリが存在しません/);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: nextAdrPathは4桁を超える番号も切り詰めずに採番する', () => {
  const workspace = createWorkspace();
  try {
    writeAdr(workspace, '10000-existing.md');
    assert.equal(nextAdrPath(workspace, 'new').relative, 'docs/adr/10001-new.md');
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: Usageはself-containedがワーカー非拘束の明示であることを説明する', () => {
  assert.match(USAGE, /ワーカーの実装や振る舞いを縛らない/);
});
