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
const { parseAgentsYaml, applySubstitutions, expandHome, stripFrontmatter, copySkillAssets, pruneStaleRecursive } =
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
      .filter(e => e.isDirectory())
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
      .filter(e => e.isDirectory())
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
