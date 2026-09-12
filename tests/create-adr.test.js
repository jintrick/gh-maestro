'use strict';

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createTempDirScope } = require('../scripts/shared/temp-directory');

const {
  createAdr,
  main,
  nextAdrPath,
  parseAdrFrontMatter,
  parseMarkdownHeadings,
  validateExistingAdrFrontMatter,
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

const tempDirScope = createTempDirScope();

test.after(() => tempDirScope.cleanup());

function createWorkspace() {
  const workspace = tempDirScope.mkdtemp('gh-maestro-create-adr-');
  fs.mkdirSync(path.join(workspace, '.gh-maestro'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'docs', 'adr'), { recursive: true });
  return workspace;
}

function cleanup() {
  // The shared scope owns all test directories and removes them in test.after.
}

function writeBody(workspace, body = VALID_BODY) {
  const file = path.join(workspace, 'body.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function runCli(workspace, args, { referenceAfter = '0' } = {}) {
  const positionArgs = referenceAfter === null
    ? []
    : ['--reference-after', String(referenceAfter)];
  return spawnSync(process.execPath, [SCRIPT, ...args, ...positionArgs, '--workspace', workspace], {
    encoding: 'utf8',
  });
}

function writeAdr(workspace, filename, content = VALID_BODY) {
  fs.writeFileSync(path.join(workspace, 'docs', 'adr', filename), content, 'utf8');
}

function writeNormative(workspace, target, content = `理由と経緯: ${target}\n`) {
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), content, 'utf8');
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
  writeAdr(workspace, '0001-first.md');
  writeAdr(workspace, '0003-third.md');
  const result = runCli(workspace, ['--next', '--slug', 'new-decision'], { referenceAfter: null });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'ADR_NEXT:docs/adr/0004-new-decision.md');
  assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0004-new-decision.md')), false);
});

test('create-adr.js: 規範文書が無い場合は作成しない', () => {
  const workspace = createWorkspace();
  try {
    const result = runCli(workspace, ['--slug', 'missing-scope', '--body-file', writeBody(workspace)]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /規範文書が指定されていません/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-missing-scope.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: --reference-afterを省略した作成は何も変更せず拒否する', () => {
  const workspace = createWorkspace();
  try {
    const normative = '# 規範\n';
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), normative, 'utf8');
    const result = runCli(workspace, [
      '--slug', 'missing-position',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
    ], { referenceAfter: null });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /--reference-afterが必要です/);
    assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), normative);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-missing-position.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: self-contained相当のフラグは作成経路にならない', () => {
  const workspace = createWorkspace();
  try {
    const result = runCli(workspace, [
      '--slug', 'not-binding',
      '--body-file', writeBody(workspace),
      '--self-contained',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /未知|unknown|予期しない/);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-not-binding.md')), false);
  } finally {
    cleanup(workspace);
  }
});

test('createAdr: CLIを経由しなくても規範文書の指定を必須にする', () => {
  const workspace = createWorkspace();
  const bodyFile = writeBody(workspace);
  assert.throws(
    () => createAdr({ workspace, slug: 'direct-call', bodyFile, referenceAfter: 0, selfContained: true }),
    /規範文書が指定されていません/,
  );
  assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-direct-call.md')), false);
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
    assert.match(`${result.stderr}${result.stdout}`, /参照先が存在しません/);
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
    writeNormative(workspace, 'docs/adr/0004-new-decision.md');
    const result = runCli(workspace, [
      '--slug', 'new-decision',
      '--body-file', bodyFile,
      '--normative-file', 'AGENTS.md',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const created = path.join(workspace, 'docs', 'adr', '0004-new-decision.md');
    assert.equal(result.stdout.trim(), 'ADR_CREATED:docs/adr/0004-new-decision.md');
    assert.equal(fs.readFileSync(created, 'utf8'), [
      '---',
      'normative-file: AGENTS.md',
      '---',
      '',
      VALID_BODY,
    ].join('\n'));
    assert.deepEqual(parseAdrFrontMatter(fs.readFileSync(created, 'utf8')), {
      normativeFile: 'AGENTS.md',
      endLine: 3,
    });
    assert.equal(
      (fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8').match(/理由と経緯: docs\/adr\/0004-new-decision\.md/g) || []).length,
      1,
    );
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 既存の規範参照があれば位置指定を無視して重複を作らない', () => {
  const workspace = createWorkspace();
  try {
    const normative = '## ADRの記録\n理由と経緯: docs/adr/0001-existing-reference.md\n';
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), normative, 'utf8');
    const result = runCli(workspace, [
      '--slug', 'existing-reference',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
    ], { referenceAfter: 'not-a-position' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), normative);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-existing-reference.md')), true);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 参照行が無い規範文書へ指定位置で挿入してADRも作成する', () => {
  const workspace = createWorkspace();
  try {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# 規範\n\n## 作成規則\n本文。\n', 'utf8');
    const result = runCli(workspace, [
      '--slug', 'inserted-reference',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
    ], { referenceAfter: 2 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8').split(/\r?\n/), [
      '# 規範',
      '',
      '理由と経緯: docs/adr/0001-inserted-reference.md',
      '## 作成規則',
      '本文。',
      '',
    ]);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-inserted-reference.md')), true);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 参照行の位置指定が不正なら作成しない', () => {
  const cases = [
    { label: '非整数', referenceAfter: 'one', pattern: /0以上の安全な整数/ },
    { label: '範囲外', referenceAfter: '3', pattern: /0から2の範囲/ },
    { label: 'コードフェンス内', referenceAfter: '2', pattern: /コードフェンスの外側/ },
  ];
  for (const item of cases) {
    const workspace = createWorkspace();
    try {
      const normative = item.label === 'コードフェンス内'
        ? '```markdown\n例\n```\n'
        : '# 規範\n本文。\n';
      fs.writeFileSync(path.join(workspace, 'AGENTS.md'), normative, 'utf8');
      const result = runCli(workspace, [
        '--slug', `invalid-position-${item.label === '非整数' ? 'text' : item.label === '範囲外' ? 'range' : 'fence'}`,
        '--body-file', writeBody(workspace),
        '--normative-file', 'AGENTS.md',
      ], { referenceAfter: item.referenceAfter });
      assert.notEqual(result.status, 0, item.label);
      assert.match(`${result.stderr}${result.stdout}`, item.pattern, item.label);
      assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), normative, item.label);
      assert.equal(fs.readdirSync(path.join(workspace, 'docs', 'adr')).length, 0, item.label);
    } finally {
      cleanup(workspace);
    }
  }
});

test('create-adr.js: 裸のファイル名言及は許容し、パスを含む壊れた参照は拒否する', () => {
  const workspace = createWorkspace();
  try {
    const normative = [
      '- `SKILL.md` は一般的なファイル名として使う。',
      '- `skills/**/SKILL.md` は複数のスキルを表す。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), normative, 'utf8');
    const result = runCli(workspace, [
      '--slug', 'generic-reference',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
    ], { referenceAfter: 1 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'),
      /理由と経緯: docs\/adr\/0001-generic-reference\.md/,
    );
  } finally {
    cleanup(workspace);
  }

  const brokenWorkspace = createWorkspace();
  try {
    const normative = '`SKILL.md` は一般名詞だが、`docs/missing.md` は壊れた参照。\n';
    fs.writeFileSync(path.join(brokenWorkspace, 'AGENTS.md'), normative, 'utf8');
    const result = runCli(brokenWorkspace, [
      '--slug', 'broken-reference',
      '--body-file', writeBody(brokenWorkspace),
      '--normative-file', 'AGENTS.md',
    ], { referenceAfter: 0 });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /参照先が存在しません/);
    assert.equal(fs.readFileSync(path.join(brokenWorkspace, 'AGENTS.md'), 'utf8'), normative);
    assert.equal(fs.readdirSync(path.join(brokenWorkspace, 'docs', 'adr')).length, 0);
  } finally {
    cleanup(brokenWorkspace);
  }
});

test('create-adr.js: ADR配置失敗時に規範文書の参照行をロールバックする', () => {
  const workspace = createWorkspace();
  try {
    const normativePath = path.join(workspace, 'AGENTS.md');
    const originalNormative = '# 規範\n';
    fs.writeFileSync(normativePath, originalNormative, 'utf8');
    const originalRename = fs.renameSync;
    let renameCount = 0;
    fs.renameSync = (source, target) => {
      renameCount += 1;
      if (renameCount === 3) {
        const error = new Error('injected ADR placement failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRename(source, target);
    };
    try {
      assert.throws(() => createAdr({
        workspace,
        slug: 'atomic-rollback',
        bodyFile: writeBody(workspace),
        normativeFile: 'AGENTS.md',
        referenceAfter: 0,
      }), /injected ADR placement failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.readFileSync(normativePath, 'utf8'), originalNormative);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-atomic-rollback.md')), false);
    assert.deepEqual(
      [
        ...fs.readdirSync(workspace),
        ...fs.readdirSync(path.join(workspace, 'docs', 'adr')),
      ].filter((name) => name.includes('.staging-') || name.includes('.backup-')),
      [],
    );
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

test('create-adr.js: コードフェンス内だけの既存参照でも外側へ新規参照を挿入する', () => {
  const workspace = createWorkspace();
  try {
    writeNormative(workspace, 'docs/adr/0001-fenced.md', [
      '```markdown',
      '理由と経緯: docs/adr/0001-fenced.md',
      '```',
      '',
    ].join('\n'));
    const result = runCli(workspace, [
      '--slug', 'fenced',
      '--body-file', writeBody(workspace),
      '--normative-file', 'AGENTS.md',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(workspace, 'docs', 'adr', '0001-fenced.md')), true);
    assert.deepEqual(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8').split(/\r?\n/), [
      '理由と経緯: docs/adr/0001-fenced.md',
      '```markdown',
      '理由と経緯: docs/adr/0001-fenced.md',
      '```',
      '',
    ]);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 許可されない追加見出しは作成前に拒否する', () => {
  const workspace = createWorkspace();
  try {
    const body = [VALID_BODY, '## その他', '', '追加。'].join('\n');
    writeNormative(workspace, 'docs/adr/0001-bad-headings.md');
    const result = runCli(workspace, [
      '--slug', 'bad-headings',
      '--body-file', writeBody(workspace, body),
      '--normative-file', 'AGENTS.md',
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

test('create-adr.js: supersedesはコードフェンス内の旧ADR言及を参照残存と誤認しない', () => {
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
    writeNormative(workspace, 'docs/adr/0002-new.md', [
      '理由と経緯: docs/adr/0002-new.md',
      '```markdown',
      '理由と経緯: docs/adr/0001-old.md',
      '```',
      '',
    ].join('\n'));
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

test('create-adr.js: front matter付きADRは規範ファイルとフェンス外の参照行を全件検査する', () => {
  const workspace = createWorkspace();
  try {
    writeNormative(workspace, 'docs/adr/0001-existing.md');
    writeAdr(workspace, '0001-existing.md', [
      '---',
      'normative-file: AGENTS.md',
      '---',
      '',
      VALID_BODY,
    ].join('\n'));
    writeAdr(workspace, '0002-legacy.md');
    const results = validateExistingAdrFrontMatter(workspace);
    assert.deepEqual(results.map((result) => ({ file: result.file, skipped: result.skipped })), [
      { file: 'docs/adr/0001-existing.md', skipped: false },
      { file: 'docs/adr/0002-legacy.md', skipped: true },
    ]);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: front matterの規範参照が無いADRは既存ADR検査で拒否する', () => {
  const workspace = createWorkspace();
  try {
    writeNormative(workspace, 'docs/adr/0001-existing.md', '規範の説明だけ。\n');
    writeAdr(workspace, '0001-existing.md', [
      '---',
      'normative-file: AGENTS.md',
      '---',
      '',
      VALID_BODY,
    ].join('\n'));
    assert.throws(
      () => validateExistingAdrFrontMatter(workspace),
      /新ADRへの参照行がありません/,
    );
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: front matterが指す規範ファイルの不在を既存ADR検査で拒否する', () => {
  const workspace = createWorkspace();
  try {
    writeAdr(workspace, '0001-existing.md', [
      '---',
      'normative-file: missing.md',
      '---',
      '',
      VALID_BODY,
    ].join('\n'));
    assert.throws(
      () => validateExistingAdrFrontMatter(workspace),
      /規範文書はAGENTS\.md|指定した規範文書が存在しません/,
    );
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 既存ADRの規範参照がコードフェンス内だけなら拒否する', () => {
  const workspace = createWorkspace();
  try {
    writeNormative(workspace, 'docs/adr/0001-existing.md', [
      '```markdown',
      '理由と経緯: docs/adr/0001-existing.md',
      '```',
      '',
    ].join('\n'));
    writeAdr(workspace, '0001-existing.md', [
      '---',
      'normative-file: AGENTS.md',
      '---',
      '',
      VALID_BODY,
    ].join('\n'));
    assert.throws(
      () => validateExistingAdrFrontMatter(workspace),
      /新ADRへの参照行がありません/,
    );
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: 一時workspace内の既存ADRを検査し、front matter無しは明示的にスキップする', () => {
  const workspace = createWorkspace();
  try {
    writeNormative(workspace, 'docs/adr/0001-existing.md');
    writeAdr(workspace, '0001-existing.md', [
      '---',
      'normative-file: AGENTS.md',
      '---',
      '',
      VALID_BODY,
    ].join('\n'));
    writeAdr(workspace, '0002-legacy.md');
    const results = validateExistingAdrFrontMatter(workspace);
    assert.deepEqual(results.map((result) => ({ file: result.file, skipped: result.skipped })), [
      { file: 'docs/adr/0001-existing.md', skipped: false },
      { file: 'docs/adr/0002-legacy.md', skipped: true },
    ]);
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: front matterの余分な項目は既存ADR検査で拒否する', () => {
  const workspace = createWorkspace();
  try {
    writeNormative(workspace, 'docs/adr/0001-existing.md');
    writeAdr(workspace, '0001-existing.md', [
      '---',
      'normative-file: AGENTS.md',
      'unexpected: value',
      '---',
      '',
      VALID_BODY,
    ].join('\n'));
    assert.throws(
      () => validateExistingAdrFrontMatter(workspace),
      /front matterにはnormative-fileだけ/,
    );
  } finally {
    cleanup(workspace);
  }
});

test('create-adr.js: mainは一時workspaceで入力エラーを返す', () => {
  const workspace = createWorkspace();
  try {
    writeNormative(workspace, 'docs/adr/0001-x.md');
    const result = main([
      '--slug', 'x',
      '--body-file', 'missing.md',
      '--normative-file', 'AGENTS.md',
      '--reference-after', '0',
      '--workspace', workspace,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ENOENT|no such file|見つかりません/i);
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

test('create-adr.js: Usageに規範なしの作成経路が無いことを示す', () => {
  assert.doesNotMatch(USAGE, /self-contained|規範文書なし/);
  assert.match(USAGE, /--normative-file/);
  assert.match(USAGE, /--reference-after/);
  assert.match(USAGE, /作成時に必須/);
});
