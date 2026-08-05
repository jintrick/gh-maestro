'use strict';
// installer.test.js
//
// 今回のバグ（{{SCRIPTS_PATH}} が未置換のまま漏れ出ていた）の再発を防ぐテスト。
// インストーラーのユーティリティ関数と、インストール後の成果物を検証する。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const {
  parseAgentsYaml, applySubstitutions, expandHome, stripFrontmatter, copySkillAssets, pruneStaleRecursive,
  buildRulesSupportedMap, assertManagedTopLevelName, quarantineLegacyHomePids,
} = require('../scripts/install.js');
const { MANAGED_TOP_LEVEL } = require('../scripts/shared/storage-layout');

// ── ユーティリティ関数のユニットテスト ──────────────────────────────────────

test('parseAgentsYaml: エージェントとdestを正しく読む', () => {
  const yaml = `
agents:
  claude:
    skill_files_install_destination_directory: ~/.claude/skills
  agy:
    skill_files_install_destination_directory: ~/.gemini/antigravity-cli/skills
`.trim();
  const result = parseAgentsYaml(yaml);
  assert.equal(result.claude.dest, '~/.claude/skills');
  assert.equal(result.agy.dest, '~/.gemini/antigravity-cli/skills');
});

test('parseAgentsYaml: substitutionsを正しく読む', () => {
  const yaml = `
agents:
  myagent:
    skill_files_install_destination_directory: ~/.myagent/skills
    skill_markdown_template_placeholder_substitutions:
      FOO: bar
      BAZ: qux
`.trim();
  const result = parseAgentsYaml(yaml);
  assert.deepEqual(result.myagent.substitutions, { FOO: 'bar', BAZ: 'qux' });
});

test('applySubstitutions: {{KEY}} を値で置換する', () => {
  const content = 'path: {{SCRIPTS_PATH}}/send-pane.js\nother: {{SCRIPTS_PATH}}/foo.js';
  const result = applySubstitutions(content, { SCRIPTS_PATH: '/abs/path/scripts' });
  assert.equal(result, 'path: /abs/path/scripts/send-pane.js\nother: /abs/path/scripts/foo.js');
});

test('applySubstitutions: 複数の共有パスplaceholderを同時に置換する', () => {
  const content = 'script: {{SCRIPTS_PATH}}/spawn-worker.js\ntemplate: {{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/issue-template.md';
  const result = applySubstitutions(content, {
    SCRIPTS_PATH: '/abs/path/scripts',
    SHARED_SKILLS_PATH: '/abs/path/skills',
  });
  assert.equal(
    result,
    'script: /abs/path/scripts/spawn-worker.js\ntemplate: /abs/path/skills/gh-maestro-orchestrator/issue-template.md'
  );
});

test('applySubstitutions: 未定義キーは残らない（全置換されること）', () => {
  const content = 'hello {{SCRIPTS_PATH}} world';
  const result = applySubstitutions(content, { SCRIPTS_PATH: '/x/y' });
  assert.ok(!result.includes('{{'), `未置換のプレースホルダーが残っている: ${result}`);
});

test('applySubstitutions: 値に $` などのJS特殊置換パターンが含まれていても文字通りに置換する', () => {
  // String.prototype.replaceAll(literalString, replacementString) は、第2引数が文字列の場合、
  // 検索側が正規表現でなくても $&/$`/$'/$$ 等を特殊パターンとして解釈する。
  // $` は「マッチ箇所より前の文字列全体」を意味するため、置換値がこの並びを含むと、
  // 意図しない周辺テキスト（今回はSKILL.mdのフロントマター）が本文中に複製されてしまう。
  const content = 'before {{X}} after';
  const value = 'lit/`$`eral';
  const result = applySubstitutions(content, { X: value });
  assert.equal(result, `before ${value} after`, `$\` が特殊パターンとして解釈され本文が破損している: ${result}`);
});

test('applySubstitutions: 実際の communication-rules.md を差し込んでもフロントマターが本文に複製されない（回帰）', () => {
  // 実障害: skills/_partials/communication-rules.md の説明文中にある例示
  // 「バッククォート/`$`入りの報告」がリテラルに $` の並びを含んでおり、
  // {{COMMUNICATION_RULES}} を差し込んだ際にSKILL.md自身のフロントマターが
  // 本文中の関係ない位置へ複製されるかたちで破損していた（explorer/investigator等で確認）。
  const communicationRules = fs.readFileSync(
    path.join(ROOT, 'skills', '_partials', 'communication-rules.md'),
    'utf8'
  ).trimEnd();
  const skillMd = [
    '---',
    'name: gh-maestro-explorer',
    'description: dummy skill for regression test',
    '---',
    '',
    '{{COMMUNICATION_RULES}}',
    '',
    '## ゴール',
  ].join('\n');

  const result = applySubstitutions(skillMd, {
    COMMUNICATION_RULES: communicationRules,
    SCRIPTS_PATH: '/abs/path/scripts',
  });

  const frontmatterOccurrences = (result.match(/name: gh-maestro-explorer/g) || []).length;
  assert.equal(
    frontmatterOccurrences,
    1,
    `本文中にフロントマターが意図せず複製されている（$\` 特殊パターン回帰）:\n${result}`
  );
});

test('coder/senior-coderの実テンプレートがinstallerのpartial配線で展開される', () => {
  const partial = name => fs.readFileSync(path.join(ROOT, 'skills', '_partials', name), 'utf8').trimEnd();
  const workflow = partial('coder-workflow.md');
  const commentsAndNaming = partial('comments-and-naming.md');
  const substitutions = {
    CODER_WORKFLOW: workflow,
    COMMENTS_AND_NAMING: commentsAndNaming,
    COMMUNICATION_RULES: partial('communication-rules.md'),
    RULES_CHECK_STEP: partial('rules-check-step.md'),
    SCRIPTS_PATH: '/abs/path/scripts',
  };
  const installSource = fs.readFileSync(path.join(ROOT, 'scripts', 'install.js'), 'utf8');

  for (const skill of ['gh-maestro-coder', 'gh-maestro-senior-coder']) {
    const template = fs.readFileSync(path.join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    assert.ok(template.includes('{{CODER_WORKFLOW}}'), `${skill}がCODER_WORKFLOWを参照していない`);
    assert.ok(template.includes('{{COMMENTS_AND_NAMING}}'), `${skill}がCOMMENTS_AND_NAMINGを参照していない`);

    const result = applySubstitutions(template, substitutions);
    assert.ok(result.includes('## ゴール'), `${skill}に共通workflowのゴールが展開されていない`);
    assert.ok(result.includes('## 制約'), `${skill}に共通workflowの制約が展開されていない`);
    assert.ok(result.includes('## コメントと命名の方針'), `${skill}に共通方針が展開されていない`);
    assert.ok(result.includes('/abs/path/scripts/publish-plan.js'), `${skill}のネストしたSCRIPTS_PATHが未展開`);
    assert.ok(!result.includes('{{'), `${skill}に未置換placeholderが残っている`);
  }

  assert.equal(
    (installSource.match(/CODER_WORKFLOW: CODER_WORKFLOW_CONTENT/g) || []).length,
    2,
    'installerのagent/shared substitutions双方にCODER_WORKFLOWが渡されていない'
  );
  assert.equal(
    (installSource.match(/COMMENTS_AND_NAMING: COMMENTS_AND_NAMING_CONTENT/g) || []).length,
    2,
    'installerのagent/shared substitutions双方にCOMMENTS_AND_NAMINGが渡されていない'
  );
});

test('expandHome: ~ をホームディレクトリに展開する', () => {
  const home = process.env.HOME || process.env.USERPROFILE;
  const result = expandHome('~/foo/bar');
  // パス区切り文字を正規化して比較（Windows: \ Linux/Mac: /）
  assert.equal(
    result.replace(/\\/g, '/'),
    (home + '/foo/bar').replace(/\\/g, '/')
  );
});

test('expandHome: ~ を含まないパスはそのまま返す', () => {
  assert.equal(expandHome('/abs/path'), '/abs/path');
});

test('stripFrontmatter: YAML frontmatterを除去する', () => {
  const content = '---\nname: test\n---\n# Content\nHello';
  assert.equal(stripFrontmatter(content), '# Content\nHello');
});

test('stripFrontmatter: frontmatterがなければそのまま返す', () => {
  const content = '# No frontmatter\nHello';
  assert.equal(stripFrontmatter(content), content);
});

// ── buildRulesSupportedMap: extends経由でrulesSupportedを継承するエントリの判定（PR #170レビュー指摘） ──

test('buildRulesSupportedMap: extendsでrulesSupportedを継承するエントリも正しくtrueと判定する', () => {
  const agentDefaults = {
    agents: [
      { id: 'base', rulesSupported: true },
      { id: 'derived', extends: 'base', command: 'derived-cli' },
    ],
  };
  const map = buildRulesSupportedMap(agentDefaults);
  assert.equal(map.get('base'), true);
  assert.equal(map.get('derived'), true, 'extends経由でrulesSupported:trueを継承したエントリはtrueと判定されるべき');
});

test('buildRulesSupportedMap: 実際のagent-defaults.jsonでclaude-ds/claude-ds-proがtrueと判定される', () => {
  const defaultsPath = path.join(ROOT, 'scripts', 'agent-defaults.json');
  const agentDefaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
  const map = buildRulesSupportedMap(agentDefaults);
  assert.equal(map.get('claude'), true);
  assert.equal(map.get('claude-ds'), true, 'claude-dsはclaudeをextendsしrulesSupported:trueを継承するはず');
  assert.equal(map.get('claude-ds-pro'), true, 'claude-ds-proはclaudeをextendsしrulesSupported:trueを継承するはず');
  assert.equal(map.get('codex'), false);
  assert.equal(map.get('codex-pro'), false, 'codex-proはcodexをextendsしrulesSupported:falseを継承するはず');
});

// ── インストール後の成果物を検証（バグ再発防止の核心） ─────────────────────────

const agentsYamlPath = path.join(ROOT, 'skills', 'agents.yaml');
const agentsContent = fs.readFileSync(agentsYamlPath, 'utf8');
const agents = parseAgentsYaml(agentsContent);

// destDir（例: ~/.claude/skills）はgh-maestroが専有するディレクトリではなく、
// 同じマシンにインストールされた他の無関係なスキル（training-attendance-check等）も
// 同居しうる共有ディレクトリである。destDir配下を無条件に全走査すると、gh-maestro管理外の
// スキルが独自にscripts/等を持つだけで誤って失敗する。gh-maestro自身が実際にインストール
// するスキル名（リポジトリのskills/配下のディレクトリ名。_partialsは実スキルではないので除外）
// だけに走査対象を絞る。
const knownSkillNames = new Set(
  fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== '_partials')
    .map(e => e.name)
);

for (const [agentName, config] of Object.entries(agents)) {
  const destDir = expandHome(config.dest);

  test(`[${agentName}] インストール後のSKILL.mdに未置換の {{...}} が残っていない`, () => {
    const skillDirs = fs.readdirSync(destDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && knownSkillNames.has(e.name))
      .map(e => e.name);

    for (const skill of skillDirs) {
      const skillMdPath = path.join(destDir, skill, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const unreplaced = content.match(/\{\{[^}]+\}\}/g);
      assert.ok(
        !unreplaced,
        `${agentName}/${skill}/SKILL.md に未置換プレースホルダーあり: ${(unreplaced || []).join(', ')}`
      );
    }
  });

  test(`[${agentName}] インストール後のSKILL.mdのSCRIPTS_PATHが絶対パスである`, () => {
    const skillDirs = fs.readdirSync(destDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && knownSkillNames.has(e.name))
      .map(e => e.name);

    for (const skill of skillDirs) {
      const skillMdPath = path.join(destDir, skill, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      const content = fs.readFileSync(skillMdPath, 'utf8');

      // node "..." で呼ばれるスクリプトパスをすべて抽出
      // $HOME や $env: などのシェル変数は実行時展開なので除外する
      const matches = [...content.matchAll(/node\s+"([^"]+\.js)"/g)]
        .map(m => m[1])
        .filter(p => !p.startsWith('$'));
      for (const scriptPath of matches) {
        assert.ok(
          path.isAbsolute(scriptPath),
          `${agentName}/${skill}/SKILL.md のスクリプトパスが相対パス: "${scriptPath}"`
        );
      }
    }
  });

  test(`[${agentName}] orchestrator SKILL.md の issue template 参照が shared skills の絶対パスである`, () => {
    const skillMdPath = path.join(destDir, 'gh-maestro-orchestrator', 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return;

    const content = fs.readFileSync(skillMdPath, 'utf8');
    const match = content.match(/`([^`]+issue-template\.md)`/);
    assert.ok(match, `${agentName}/gh-maestro-orchestrator/SKILL.md に issue-template.md 参照が見つからない`);
    assert.ok(
      path.isAbsolute(match[1]),
      `${agentName}/gh-maestro-orchestrator/SKILL.md の issue-template 参照が相対パス: "${match[1]}"`
    );
  });

  test(`[${agentName}] スキルディレクトリに scripts/ サブディレクトリが存在しない（SKILL.mdのみ）`, () => {
    const skillDirs = fs.readdirSync(destDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && knownSkillNames.has(e.name))
      .map(e => e.name);
    for (const skill of skillDirs) {
      const perSkillScripts = path.join(destDir, skill, 'scripts');
      assert.ok(
        !fs.existsSync(perSkillScripts),
        `スクリプトは集約先に置くべきで、per-skill の scripts/ は存在してはならない: ${perSkillScripts}`
      );
    }
  });

  // 全エージェントがresume方式（inbox-supervisor.js経由）に統一されているため、
  // どのエージェント向けインストール先にも自己ポーリング専用の起動指示（旧Monitor方式）が
  // 紛れ込んではならない。過去、reasonix（当時のskillsViaMd機構）がこの種の取り違えで
  // 実行不能な指示を受け取った実障害（PR #38）の再発防止。
  test(`[${agentName}] に自己ポーリング専用のMonitor起動指示が含まれない`, () => {
    const skillDirs = fs.readdirSync(destDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && knownSkillNames.has(e.name))
      .map(e => e.name)
      .filter(name => name !== 'gh-maestro-orchestrator');

    for (const skill of skillDirs) {
      const skillMdPath = path.join(destDir, skill, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;
      const content = fs.readFileSync(skillMdPath, 'utf8');
      assert.ok(
        !content.includes('最初のツール呼び出しとして'),
        `${agentName}/${skill}/SKILL.md に自己ポーリング専用のMonitor起動指示が含まれている`
      );
      assert.ok(
        !content.includes('persistent: true'),
        `${agentName}/${skill}/SKILL.md にMonitor専用の persistent: true 指示が含まれている`
      );
    }
  });
}

test('共有スキル配布先に orchestrator の issue-template.md が配置される', () => {
  const sharedSkillsDir = expandHome('~/.gh-maestro/skills');
  const templatePath = path.join(sharedSkillsDir, 'gh-maestro-orchestrator', 'issue-template.md');
  assert.ok(fs.existsSync(templatePath), `共有スキル配布先に issue-template.md が存在しない: ${templatePath}`);
});

// 全エージェントはそれぞれのネイティブなスキル発見機構（skill_files_install_destination_directory）
// でSKILL.mdを読む方式に統一済み（reasonixも含む）。~/.gh-maestro/skills/ 配下の共有コピーは
// orchestrator専用の非SKILL.mdアセット配布用（issue-template.md等）であり、置換には常にclaude用
// substitutionsを使う。ワーカーエージェントが直接読むことはないため、Monitor前提の指示が
// 含まれていること自体は問題ではない（かつてreasonix等がこの共有コピーをAGENTS.md経由で読む
// 特別扱いだった名残の検証はここでは行わない）。

test('共有スキルのSKILL.mdに未置換の {{...}} が残っていない', () => {
  const sharedSkillsDir = expandHome('~/.gh-maestro/skills');
  const skillDirs = fs.readdirSync(sharedSkillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const skill of skillDirs) {
    const skillMdPath = path.join(sharedSkillsDir, skill, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    const content = fs.readFileSync(skillMdPath, 'utf8');
    const unreplaced = content.match(/\{\{[^}]+\}\}/g);
    assert.ok(
      !unreplaced,
      `共有スキル ${skill}/SKILL.md に未置換プレースホルダーあり: ${(unreplaced || []).join(', ')}`
    );
  }
});

// ── assertManagedTopLevelName / quarantineLegacyHomePids（Issue #214） ────────

test('assertManagedTopLevelName: MANAGED_TOP_LEVEL に宣言済みの名前は throw しない', () => {
  for (const name of MANAGED_TOP_LEVEL) {
    assert.doesNotThrow(() => assertManagedTopLevelName(name));
  }
});

test('assertManagedTopLevelName: 未宣言の名前（登録漏れ）は throw する', () => {
  assert.throws(() => assertManagedTopLevelName('pids'), /MANAGED_TOP_LEVEL/);
  assert.throws(() => assertManagedTopLevelName('workflows'));
});

test('quarantineLegacyHomePids: 隔離元ディレクトリが存在しない場合は ok:true, migrated:0', () => {
  const tmpdir = require('os').tmpdir();
  const nonexistent = path.join(tmpdir, 'gh-maestro-test-quarantine-nonexistent-' + Date.now());
  const quarantineDir = path.join(tmpdir, 'gh-maestro-test-quarantine-dest-' + Date.now());
  const result = quarantineLegacyHomePids(nonexistent, quarantineDir);
  assert.deepEqual(result, { ok: true, migrated: 0, errors: [] });
  assert.ok(!fs.existsSync(quarantineDir), '隔離元が無ければ隔離先も作られないはず');
});

test('quarantineLegacyHomePids: 正常なJSONレコードを全て隔離先へコピーする', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-quarantine-src-'));
  const dest = path.join(tmpdir, 'gh-maestro-test-quarantine-dest-' + Date.now());
  try {
    fs.writeFileSync(path.join(src, '111.json'), JSON.stringify({ pid: 111, script: 'poll-reviews.js' }));
    fs.writeFileSync(path.join(src, '222.json'), JSON.stringify({ pid: 222, script: 'msg-poll.js' }));
    fs.writeFileSync(path.join(src, '.startup-lock-foo'), JSON.stringify({ pid: 111 }));

    const result = quarantineLegacyHomePids(src, dest);

    assert.equal(result.ok, true);
    assert.equal(result.migrated, 3);
    assert.deepEqual(result.errors, []);
    assert.ok(fs.existsSync(path.join(dest, '111.json')));
    assert.ok(fs.existsSync(path.join(dest, '222.json')));
    assert.ok(fs.existsSync(path.join(dest, '.startup-lock-foo')));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dest, '111.json'), 'utf8')).pid,
      111
    );
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('quarantineLegacyHomePids: 壊れたJSONが1件でもあれば ok:false を返す（fail-closed）', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-quarantine-corrupt-src-'));
  const dest = path.join(tmpdir, 'gh-maestro-test-quarantine-corrupt-dest-' + Date.now());
  try {
    fs.writeFileSync(path.join(src, '111.json'), JSON.stringify({ pid: 111 }));
    fs.writeFileSync(path.join(src, '999.json'), 'not valid json {{{');

    const result = quarantineLegacyHomePids(src, dest);

    assert.equal(result.ok, false, '壊れたJSONが1件でもあれば全体を ok:false にする');
    assert.ok(result.errors.some(e => e.includes('999.json')));
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
  }
});

test('quarantineLegacyHomePids: JSON以外のファイル（startup-lock等）は中身を検証せずコピーする', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-quarantine-nonjson-src-'));
  const dest = path.join(tmpdir, 'gh-maestro-test-quarantine-nonjson-dest-' + Date.now());
  try {
    fs.writeFileSync(path.join(src, '.startup-lock-bar'), 'not json at all');

    const result = quarantineLegacyHomePids(src, dest);

    assert.equal(result.ok, true);
    assert.equal(result.migrated, 1);
    assert.equal(fs.readFileSync(path.join(dest, '.startup-lock-bar'), 'utf8'), 'not json at all');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

// ── pruneStaleRecursive（G1） ─────────────────────────────────────────────────

test('pruneStaleRecursive: サブディレクトリ内のstaleファイルを削除する', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-prune-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-prune-dest-'));
  try {
    // ソース: sub/a.js のみ
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'a.js'), 'a');

    // dest: sub/a.js + sub/stale.js（ゴーストファイル）
    fs.mkdirSync(path.join(dest, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'sub', 'a.js'), 'a');
    fs.writeFileSync(path.join(dest, 'sub', 'stale.js'), 'stale');

    pruneStaleRecursive(src, dest);

    assert.ok(!fs.existsSync(path.join(dest, 'sub', 'stale.js')), 'staleファイルが削除されている');
    assert.ok(fs.existsSync(path.join(dest, 'sub', 'a.js')), 'ソースに存在するファイルは残っている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('pruneStaleRecursive: サブディレクトリ内のstaleサブディレクトリを削除する', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-prune-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-prune-dest-'));
  try {
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'a.js'), 'a');

    fs.mkdirSync(path.join(dest, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'sub', 'a.js'), 'a');
    fs.mkdirSync(path.join(dest, 'sub', 'stale-dir'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'sub', 'stale-dir', 'ghost.txt'), 'ghost');

    pruneStaleRecursive(src, dest);

    assert.ok(!fs.existsSync(path.join(dest, 'sub', 'stale-dir')), 'staleなサブディレクトリが削除されている');
    assert.ok(fs.existsSync(path.join(dest, 'sub', 'a.js')), 'ソースに存在するファイルは残っている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('pruneStaleRecursive: トップレベルのstaleファイルも削除する', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-prune-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-prune-dest-'));
  try {
    fs.writeFileSync(path.join(src, 'a.js'), 'a');
    fs.writeFileSync(path.join(dest, 'a.js'), 'a');
    fs.writeFileSync(path.join(dest, 'stale.js'), 'stale');

    pruneStaleRecursive(src, dest);

    assert.ok(!fs.existsSync(path.join(dest, 'stale.js')), 'トップレベルのstaleファイルが削除されている');
    assert.ok(fs.existsSync(path.join(dest, 'a.js')), 'ソースに存在するファイルは残っている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

// ── copySkillAssets: サブディレクトリと拡張子フィルタ（G2, G3） ──────────────

test('copySkillAssets: 拡張子 .txt と .yaml のファイルもコピー対象になる（G3）', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-dest-'));
  try {
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(src, 'README.txt'), 'readme');
    fs.writeFileSync(path.join(src, 'config.yaml'), 'key: val');
    fs.writeFileSync(path.join(src, 'data.json'), '{}');

    copySkillAssets(src, dest, {});

    assert.ok(fs.existsSync(path.join(dest, 'README.txt')), '.txt ファイルがコピーされている');
    assert.ok(fs.existsSync(path.join(dest, 'config.yaml')), '.yaml ファイルがコピーされている');
    assert.ok(fs.existsSync(path.join(dest, 'data.json')), '.json ファイルがコピーされている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('copySkillAssets: destに残った未知のサブディレクトリを削除する（G2）', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-dest-'));
  try {
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill');

    // dest に未知のサブディレクトリを作成
    fs.mkdirSync(path.join(dest, 'old-subdir'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'old-subdir', 'stale.txt'), 'stale');

    copySkillAssets(src, dest, {});

    assert.ok(!fs.existsSync(path.join(dest, 'old-subdir')), '未知のサブディレクトリが削除されている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('copySkillAssets: サブディレクトリ内のファイルを再帰コピーする（Issue #120）', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-dest-'));
  try {
    fs.mkdirSync(path.join(src, 'aspects'), { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(src, 'aspects', 'correctness.md'), '## Correctness');
    fs.writeFileSync(path.join(src, 'aspects', 'maintainability.md'), '## Maintainability');

    copySkillAssets(src, dest, {});

    assert.ok(fs.existsSync(path.join(dest, 'aspects', 'correctness.md')), 'サブディレクトリのファイルがコピーされている');
    assert.ok(fs.existsSync(path.join(dest, 'aspects', 'maintainability.md')), 'サブディレクトリのファイルがコピーされている');
    assert.equal(fs.readFileSync(path.join(dest, 'aspects', 'correctness.md'), 'utf8'), '## Correctness');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('copySkillAssets: サブディレクトリのファイルにもapplySubstitutionsが適用される（Issue #120）', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-dest-'));
  try {
    fs.mkdirSync(path.join(src, 'aspects'), { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(src, 'aspects', 'correctness.md'), 'path: {{SCRIPTS_PATH}}/test.js');

    copySkillAssets(src, dest, { SCRIPTS_PATH: '/custom/path' });

    const content = fs.readFileSync(path.join(dest, 'aspects', 'correctness.md'), 'utf8');
    assert.equal(content, 'path: /custom/path/test.js');
    assert.ok(!content.includes('{{'), 'サブディレクトリ内のファイルでもプレースホルダーが置換されている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('copySkillAssets: 2階層以上ネストしたサブディレクトリも再帰コピーする（Issue #120）', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-dest-'));
  try {
    fs.mkdirSync(path.join(src, 'aspects', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(src, 'aspects', 'correctness.md'), '## Correctness');
    fs.writeFileSync(path.join(src, 'aspects', 'deep', 'nested.md'), '## Nested');

    copySkillAssets(src, dest, {});

    assert.ok(fs.existsSync(path.join(dest, 'aspects', 'correctness.md')), '1階層目のファイルがコピーされている');
    assert.ok(fs.existsSync(path.join(dest, 'aspects', 'deep', 'nested.md')), '2階層目のファイルがコピーされている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('copySkillAssets: サブディレクトリ内のstaleファイルも削除される（Issue #120）', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-dest-'));
  try {
    fs.mkdirSync(path.join(src, 'aspects'), { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(src, 'aspects', 'correctness.md'), '## Correctness');

    // dest にソースに無いファイルを配置
    fs.mkdirSync(path.join(dest, 'aspects'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'aspects', 'correctness.md'), '## Old');
    fs.writeFileSync(path.join(dest, 'aspects', 'stale.md'), 'stale');

    copySkillAssets(src, dest, {});

    assert.ok(fs.existsSync(path.join(dest, 'aspects', 'correctness.md')), 'ソースに存在するファイルは残っている');
    assert.ok(!fs.existsSync(path.join(dest, 'aspects', 'stale.md')), 'サブディレクトリ内のstaleファイルが削除されている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test('copySkillAssets: destに残った未知のファイルを削除する', () => {
  const tmpdir = require('os').tmpdir();
  const src = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-src-'));
  const dest = fs.mkdtempSync(path.join(tmpdir, 'gh-maestro-test-skill-dest-'));
  try {
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(dest, 'SKILL.md'), '# Old');
    fs.writeFileSync(path.join(dest, 'stale.md'), 'stale');

    copySkillAssets(src, dest, {});

    assert.ok(!fs.existsSync(path.join(dest, 'stale.md')), '未知のファイルが削除されている');
    assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), 'SKILL.md は残っている');
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

const SHARED_SCRIPTS = expandHome('~/.gh-maestro/scripts');

// スキル固有・base・lib・共有スクリプトが1か所に集約されている代表例
for (const name of ['msg-send.js', 'unlink-junctions.js', 'spawn-worker.js', 'start-review-manager.js', 'poll-pr.js', 'review-publisher.js']) {
  test(`集約先に ${name} が存在する`, () => {
    const p = path.join(SHARED_SCRIPTS, name);
    assert.ok(fs.existsSync(p), `集約先に存在しない: ${p}`);
  });
}

test('集約先に agents.yaml が配布され、内容が skills/agents.yaml と一致する', () => {
  const distributed = path.join(SHARED_SCRIPTS, 'agents.yaml');
  const original = path.join(ROOT, 'skills', 'agents.yaml');
  assert.ok(fs.existsSync(distributed), `集約先に存在しない: ${distributed}`);
  assert.equal(fs.readFileSync(distributed, 'utf8'), fs.readFileSync(original, 'utf8'));
});
