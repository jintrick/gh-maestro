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
const { parseAgentsYaml, applySubstitutions, expandHome, stripFrontmatter } =
  require('../scripts/install.js');

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

test('applySubstitutions: 未定義キーは残らない（全置換されること）', () => {
  const content = 'hello {{SCRIPTS_PATH}} world';
  const result = applySubstitutions(content, { SCRIPTS_PATH: '/x/y' });
  assert.ok(!result.includes('{{'), `未置換のプレースホルダーが残っている: ${result}`);
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

// ── インストール後の成果物を検証（バグ再発防止の核心） ─────────────────────────

const agentsYamlPath = path.join(ROOT, 'skills', 'agents.yaml');
const agentsContent = fs.readFileSync(agentsYamlPath, 'utf8');
const agents = parseAgentsYaml(agentsContent);

for (const [agentName, config] of Object.entries(agents)) {
  const destDir = expandHome(config.dest);

  test(`[${agentName}] インストール後のSKILL.mdに未置換の {{...}} が残っていない`, () => {
    const skillDirs = fs.readdirSync(destDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
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
      .filter(e => e.isDirectory())
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

  test(`[${agentName}] SCRIPTS_PATHが指すディレクトリに send-pane.js が存在する`, () => {
    const orchestratorScripts = path.join(destDir, 'gh-maestro-orchestrator', 'scripts');
    assert.ok(
      fs.existsSync(orchestratorScripts),
      `orchestratorのscriptsディレクトリが存在しない: ${orchestratorScripts}`
    );
    const sendPane = path.join(orchestratorScripts, 'send-pane.js');
    assert.ok(
      fs.existsSync(sendPane),
      `send-pane.js が存在しない: ${sendPane}`
    );
  });
}
