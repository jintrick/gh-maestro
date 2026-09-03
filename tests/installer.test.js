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

const ROOT = path.join(__dirname, '..');
const {
  parseAgentsYaml, applySubstitutions, expandHome, stripFrontmatter, copySkillAssets, pruneStaleRecursive,
  buildRulesSupportedMap, assertManagedTopLevelName, quarantineLegacyHomePids, installSkills,
  installScripts, installSharedSkills, restartResidentsAfterInstall, printInstallCompletion,
} = require('../scripts/install.js');
const { MANAGED_TOP_LEVEL } = require('../scripts/shared/storage-layout');

test('restartResidentsAfterInstall: 登録済みの全workspaceに配布済みCLIを明示引数付きで呼び出す', () => {
  const workspaces = [
    path.join(os.tmpdir(), 'gh-maestro-install-workspace-a'),
    path.join(os.tmpdir(), 'gh-maestro-install-workspace-b'),
  ];
  const sharedScripts = path.join(os.tmpdir(), 'gh-maestro-installed-scripts');
  const calls = [];
  const notices = [];

  const result = restartResidentsAfterInstall({
    listRegisteredWorkspaces: () => workspaces,
    workspaceExists: () => true,
    callerWorkspace: null,
    sharedScripts,
    onWorkspace: (workspace) => notices.push(workspace),
    execFileSync: (...args) => calls.push(args),
  });

  assert.deepEqual(result, {
    attempted: true,
    code: 0,
    workspaces,
    results: workspaces.map((workspace) => ({ workspace, code: 0 })),
    scriptPath: path.join(sharedScripts, 'restart-residents.js'),
    callerWorkspace: null,
    callerReattachLines: [],
  });
  assert.deepEqual(notices, workspaces);
  assert.deepEqual(calls, workspaces.map((workspace) => [
    process.execPath,
    [path.join(sharedScripts, 'restart-residents.js'), '--workspace', workspace],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
  ]));
});

test('restartResidentsAfterInstall: 登録workspaceが無い場合は常駐操作を実行しない', () => {
  let called = false;
  const result = restartResidentsAfterInstall({
    listRegisteredWorkspaces: () => [],
    execFileSync: () => { called = true; },
  });

  assert.deepEqual(result, { attempted: false, code: 0, workspaces: [], callerReattachLines: [] });
  assert.equal(called, false, '登録workspaceが無い場合はrestart CLIを呼び出さない');
});

test('restartResidentsAfterInstall: ディスク上にないworkspaceは通知・restart CLI呼び出し・結果から除外する', () => {
  const missing = path.join(os.tmpdir(), `gh-maestro-install-missing-${process.pid}-${Date.now()}`);
  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-install-existing-'));
  const calls = [];
  const notices = [];

  try {
    const result = restartResidentsAfterInstall({
      workspaces: [missing, existing],
      callerWorkspace: null,
      sharedScripts: path.join(os.tmpdir(), 'gh-maestro-installed-scripts'),
      onWorkspace: (workspace) => notices.push(workspace),
      execFileSync: (...args) => calls.push(args),
    });

    assert.equal(result.attempted, true);
    assert.deepEqual(result.workspaces, [existing]);
    assert.deepEqual(result.results, [{ workspace: existing, code: 0 }]);
    assert.deepEqual(notices, [existing], '存在しないworkspaceの通知を出さない');
    assert.equal(calls.length, 1, '存在しないworkspaceのrestart CLIを呼び出さない');
    assert.equal(calls[0][1][2], existing);
  } finally {
    fs.rmSync(existing, { recursive: true, force: true });
  }
});

test('restartResidentsAfterInstall: workspace存在確認に失敗した場合は常駐操作を開始しない', () => {
  const error = new Error('workspace stat failed');
  let called = false;
  const result = restartResidentsAfterInstall({
    workspaces: [path.join(os.tmpdir(), 'gh-maestro-install-stat-failure')],
    workspaceExists: () => { throw error; },
    execFileSync: () => { called = true; },
  });

  assert.equal(result.attempted, false);
  assert.equal(result.code, 1);
  assert.deepEqual(result.workspaces, []);
  assert.equal(result.error, error);
  assert.equal(called, false, '存在確認不能時はrestart CLIを呼び出さない');
});

test('restartResidentsAfterInstall: 1つのworkspaceの失敗後も残りを処理し、失敗を報告する', () => {
  const error = Object.assign(new Error('restart failed'), { status: 1 });
  const workspaces = [
    path.join(os.tmpdir(), 'gh-maestro-install-workspace-failed'),
    path.join(os.tmpdir(), 'gh-maestro-install-workspace-after-failed'),
  ];
  const calls = [];
  const result = restartResidentsAfterInstall({
    workspaces,
    workspaceExists: () => true,
    callerWorkspace: null,
    sharedScripts: path.join(os.tmpdir(), 'gh-maestro-installed-scripts'),
    execFileSync: (...args) => {
      calls.push(args);
      if (calls.length === 1) throw error;
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.code, 1);
  assert.deepEqual(result.workspaces, workspaces);
  assert.equal(result.results[0].error, error);
  assert.equal(result.results[0].code, 1);
  assert.deepEqual(result.results[1], { workspace: workspaces[1], code: 0 });
  assert.equal(calls.length, 2, '1つ目の失敗で後続workspaceを飛ばさない');
});

test('restartResidentsAfterInstall: workspace registryの読取失敗を握りつぶさず、CLIを呼び出さない', () => {
  const error = new Error('registry unreadable');
  let called = false;
  const result = restartResidentsAfterInstall({
    listRegisteredWorkspaces: () => { throw error; },
    execFileSync: () => { called = true; },
  });

  assert.equal(result.attempted, false);
  assert.equal(result.code, 1);
  assert.deepEqual(result.workspaces, []);
  assert.equal(result.error, error);
  assert.equal(called, false, 'registryを読めない場合は常駐操作を実行しない');
});

test('restartResidentsAfterInstall: 実際のrestart-residents.jsがworkspace引数を受理する', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-install-real-cli-'));
  const result = restartResidentsAfterInstall({
    workspaces: [workspace],
    callerWorkspace: null,
    sharedScripts: path.join(ROOT, 'scripts'),
  });

  assert.equal(result.attempted, true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.results, [{ workspace, code: 0 }]);
  assert.deepEqual(result.callerReattachLines, []);
});

test('末尾再掲: 呼び出し元 workspace に再接続要求があるとき、gh-maestro installed. より後にその行が出る', () => {
  const callerWs = path.join(os.tmpdir(), 'gh-maestro-caller-ws');
  const otherWs = path.join(os.tmpdir(), 'gh-maestro-other-ws');
  const written = [];
  const mockStdout = {
    write: (chunk) => written.push(chunk),
  };

  const result = restartResidentsAfterInstall({
    workspaces: [callerWs, otherWs],
    workspaceExists: () => true,
    callerWorkspace: callerWs,
    stdout: mockStdout,
    sharedScripts: path.join(os.tmpdir(), 'gh-maestro-installed-scripts'),
    execFileSync: (cmd, args) => {
      const wsIdx = args.indexOf('--workspace');
      const targetWs = args[wsIdx + 1];
      if (targetWs === callerWs) {
        return 'RESIDENT script=msg-poll.js status=monitor-required\nMONITOR_REATTACH_REQUIRED script=msg-poll.js command="node" "msg-poll.js" "orchestrator"\n';
      }
      return 'RESIDENT script=msg-poll.js status=monitor-required\nMONITOR_REATTACH_REQUIRED script=msg-poll.js command="node" "msg-poll.js" "other"\n';
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.callerReattachLines, [
    'MONITOR_REATTACH_REQUIRED script=msg-poll.js command="node" "msg-poll.js" "orchestrator"',
  ]);
  assert.equal(written.length, 2, '各workspaceの出力が端末ストリームへ素通しされること');

  const outputLines = [];
  printInstallCompletion(result, (line) => outputLines.push(line));

  const installedIdx = outputLines.findIndex((l) => l.includes('gh-maestro installed.'));
  const usageIdx = outputLines.findIndex((l) => l.includes('Usage:'));
  const reattachIdx = outputLines.findIndex((l) => l.includes('MONITOR_REATTACH_REQUIRED script=msg-poll.js command="node" "msg-poll.js" "orchestrator"'));

  assert.ok(installedIdx !== -1, 'gh-maestro installed. が出力されていること');
  assert.ok(usageIdx > installedIdx, 'Usage案内が gh-maestro installed. の後に出ること');
  assert.ok(reattachIdx > installedIdx, '呼び出し元の再接続要求が gh-maestro installed. より後に出ること');
  assert.ok(reattachIdx > usageIdx, '呼び出し元の再接続要求が Usage 案内より後に出ること');
  assert.ok(!outputLines.some((l) => l.includes('"other"')), '呼び出し元以外の再接続要求は再掲されないこと');
});

test('末尾再掲: 再接続要求が無いとき、何も追加されない', () => {
  const callerWs = path.join(os.tmpdir(), 'gh-maestro-caller-ws-clean');
  const result = restartResidentsAfterInstall({
    workspaces: [callerWs],
    workspaceExists: () => true,
    callerWorkspace: callerWs,
    sharedScripts: path.join(os.tmpdir(), 'gh-maestro-installed-scripts'),
    execFileSync: () => 'RESIDENT script=msg-poll.js status=not-running\n',
  });

  assert.equal(result.attempted, true);
  assert.deepEqual(result.callerReattachLines, []);

  const outputLines = [];
  printInstallCompletion(result, (line) => outputLines.push(line));

  const installedIdx = outputLines.findIndex((l) => l.includes('gh-maestro installed.'));
  assert.ok(installedIdx !== -1, 'gh-maestro installed. が出力されていること');
  assert.ok(!outputLines.some((l) => l.includes('MONITOR_REATTACH_REQUIRED')), '再接続要求が出力に含まれないこと');
  assert.ok(outputLines[outputLines.length - 1].includes('Type: /gh-maestro'), '末尾がUsage案内のまま終わること');
});

test('末尾再掲: 呼び出し元以外の workspace の再接続要求は再掲されない', () => {
  const callerWs = path.join(os.tmpdir(), 'gh-maestro-caller-ws-only');
  const otherWs = path.join(os.tmpdir(), 'gh-maestro-other-ws-only');
  const result = restartResidentsAfterInstall({
    workspaces: [otherWs],
    workspaceExists: () => true,
    callerWorkspace: callerWs,
    sharedScripts: path.join(os.tmpdir(), 'gh-maestro-installed-scripts'),
    execFileSync: () => 'RESIDENT script=msg-poll.js status=monitor-required\nMONITOR_REATTACH_REQUIRED script=msg-poll.js command="node" "other"\n',
  });

  assert.equal(result.attempted, true);
  assert.deepEqual(result.callerReattachLines, []);

  const outputLines = [];
  printInstallCompletion(result, (line) => outputLines.push(line));

  assert.ok(!outputLines.some((l) => l.includes('MONITOR_REATTACH_REQUIRED')), '呼び出し元以外の再接続要求は末尾に再掲されないこと');
});

test('末尾再掲: 呼び出し元 workspace が特定できないとき、何も追加されずエラーにもならない', () => {
  const ws = path.join(os.tmpdir(), 'gh-maestro-ws-unresolved');
  const result = restartResidentsAfterInstall({
    workspaces: [ws],
    workspaceExists: () => true,
    callerWorkspace: null,
    sharedScripts: path.join(os.tmpdir(), 'gh-maestro-installed-scripts'),
    execFileSync: () => 'RESIDENT script=msg-poll.js status=monitor-required\nMONITOR_REATTACH_REQUIRED script=msg-poll.js command="node"\n',
  });

  assert.equal(result.attempted, true);
  assert.equal(result.code, 0);
  assert.deepEqual(result.callerReattachLines, []);

  const outputLines = [];
  assert.doesNotThrow(() => {
    printInstallCompletion(result, (line) => outputLines.push(line));
  });
  assert.ok(!outputLines.some((l) => l.includes('MONITOR_REATTACH_REQUIRED')), '再接続要求は追加されないこと');
});

// ── ユーティリティ関数のユニットテスト ──────────────────────────────────────

test('installSkills: 複数宛先（dests配列）を持つエージェントですべての宛先にSKILL.mdが最新展開される', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-install-skills-test-'));
  const destNew = path.join(tmpBase, 'agents-skills');
  const destOld = path.join(tmpBase, 'gemini-skills');

  try {
    const testAgents = {
      agy: {
        dests: [destNew, destOld],
        substitutions: {},
      },
    };

    const sharedScriptsDir = path.join(tmpBase, 'shared-scripts');
    const sharedSkillsDir = path.join(tmpBase, 'shared-skills');

    installSkills(testAgents, {
      skillsDir: path.join(ROOT, 'skills'),
      sharedScripts: sharedScriptsDir,
      sharedSkills: sharedSkillsDir,
      rulesSupportedMap: new Map([['agy', false]]),
      step: () => {},
      ok: () => {},
    });

    const expectedSkillDirs = fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_'))
      .map(e => e.name);

    for (const dest of [destNew, destOld]) {
      assert.ok(fs.existsSync(dest), `宛先ディレクトリが存在しない: ${dest}`);

      for (const skill of expectedSkillDirs) {
        const skillMd = path.join(dest, skill, 'SKILL.md');
        assert.ok(fs.existsSync(skillMd), `${skill}/SKILL.md が生成されていない (${dest})`);

        const content = fs.readFileSync(skillMd, 'utf8');
        // 未置換プレースホルダーが残っていないこと
        const unreplaced = content.match(/\{\{[^}]+\}\}/g);
        assert.ok(!unreplaced, `未置換プレースホルダーあり (${skillMd}): ${(unreplaced || []).join(', ')}`);

        // sharedScripts が埋め込まれていること
        assert.ok(
          content.includes(sharedScriptsDir) || !content.includes('node "'),
          `SCRIPTS_PATH が正しく展開されていない (${skillMd})`
        );
      }
    }

    // 新旧両方の宛先に生成された全SKILL.mdの内容が完全に一致すること
    for (const skill of expectedSkillDirs) {
      const contentNew = fs.readFileSync(path.join(destNew, skill, 'SKILL.md'), 'utf8');
      const contentOld = fs.readFileSync(path.join(destOld, skill, 'SKILL.md'), 'utf8');
      assert.equal(contentNew, contentOld, `${skill}/SKILL.md の内容が新旧の宛先で一致しない`);
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('installSkills / installScripts / installSharedSkills: options省略時でもTDZエラーを起こさずSHARED_SCRIPTS等のデフォルト値を使う', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-default-opts-test-'));
  const destDir = path.join(tmpBase, 'test-agent-skills');

  try {
    const testAgents = {
      testAgent: {
        dests: [destDir],
        substitutions: {},
      },
    };

    // options 省略（または空オブジェクト）で呼び出しても TDZ ReferenceError が発生しないこと
    assert.doesNotThrow(() => {
      installSkills(testAgents, { step: () => {}, ok: () => {} });
    });

    const coderSkillMd = path.join(destDir, 'gh-maestro-coder', 'SKILL.md');
    assert.ok(fs.existsSync(coderSkillMd), 'installSkills がデフォルト設定で成果物を生成できること');
    const coderContent = fs.readFileSync(coderSkillMd, 'utf8');
    const defaultSharedScripts = path.join(expandHome('~/.gh-maestro'), 'scripts');
    assert.ok(
      coderContent.includes(defaultSharedScripts),
      'options.sharedScripts 省略時に SHARED_SCRIPTS がデフォルト値として使われること'
    );

    const orchestratorSkillMd = path.join(destDir, 'gh-maestro-orchestrator', 'SKILL.md');
    assert.ok(fs.existsSync(orchestratorSkillMd), 'gh-maestro-orchestrator/SKILL.md が生成されていること');
    const orchestratorContent = fs.readFileSync(orchestratorSkillMd, 'utf8');
    const defaultSharedSkills = path.join(expandHome('~/.gh-maestro'), 'skills');
    assert.ok(
      orchestratorContent.includes(defaultSharedSkills),
      'options.sharedSkills 省略時に SHARED_SKILLS がデフォルト値として使われること'
    );

    // installScripts / installSharedSkills も options 省略で TDZ エラーなく実行できること
    assert.doesNotThrow(() => {
      installScripts({ sharedScripts: path.join(tmpBase, 'scripts'), step: () => {}, ok: () => {} });
    });
    assert.doesNotThrow(() => {
      installSharedSkills(testAgents, { sharedSkills: path.join(tmpBase, 'skills'), step: () => {}, ok: () => {} });
    });
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

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
  assert.deepEqual(result.claude.dests, ['~/.claude/skills']);
  assert.equal(result.agy.dest, '~/.gemini/antigravity-cli/skills');
  assert.deepEqual(result.agy.dests, ['~/.gemini/antigravity-cli/skills']);
});

test('parseAgentsYaml: リスト形式のdestを正しく読む', () => {
  const yaml = `
agents:
  agy:
    skill_files_install_destination_directory:
      - ~/.agents/skills
      - ~/.gemini/antigravity-cli/skills
`.trim();
  const result = parseAgentsYaml(yaml);
  assert.equal(result.agy.dest, '~/.agents/skills');
  assert.deepEqual(result.agy.dests, [
    '~/.agents/skills',
    '~/.gemini/antigravity-cli/skills',
  ]);
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
  // 本文中の関係ない位置へ複製されるかたちで破損していた（explorer/diagnostician等で確認）。
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
// 実環境（~/.claude/skills 等）ではなく一時ディレクトリに対して installSkills / installScripts / installSharedSkills
// を実行し、生成された成果物を検証する。

test('インストーラー成果物検証: 全エージェント宛先・共有スキル・共有スクリプトが一時ディレクトリに正しく生成される', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-installer-e2e-test-'));
  const tmpSharedScripts = path.join(tmpBase, 'shared-scripts');
  const tmpSharedSkills = path.join(tmpBase, 'shared-skills');

  try {
    const agentsYamlPath = path.join(ROOT, 'skills', 'agents.yaml');
    const agents = parseAgentsYaml(fs.readFileSync(agentsYamlPath, 'utf8'));

    const defaultsPath = path.join(ROOT, 'scripts', 'agent-defaults.json');
    const agentDefaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
    const rulesSupportedMap = buildRulesSupportedMap(agentDefaults);

    // テスト用に各エージェントの dest / dests を tmpBase 配下の個別ディレクトリに置き換えた agents 設定を作成
    const testAgents = {};
    const agentDestEntries = []; // { agentName, rawDest, destDir, label }

    for (const [agentName, config] of Object.entries(agents)) {
      const destList = (config.dests && config.dests.length > 0)
        ? config.dests
        : (config.dest ? [config.dest] : []);

      const tmpDests = [];
      for (let i = 0; i < destList.length; i++) {
        const rawDest = destList[i];
        const destDir = path.join(tmpBase, `dest-${agentName}-${i}`);
        tmpDests.push(destDir);
        const label = destList.length > 1 ? `${agentName}:${rawDest}` : agentName;
        agentDestEntries.push({ agentName, rawDest, destDir, label });
      }

      testAgents[agentName] = {
        dests: tmpDests,
        dest: tmpDests[0],
        substitutions: config.substitutions || {},
      };
    }

    const skillsDir = path.join(ROOT, 'skills');
    const knownSkillNames = new Set(
      fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('_'))
        .map(e => e.name)
    );

    // 1. エージェントスキルのインストール
    installSkills(testAgents, {
      skillsDir,
      sharedScripts: tmpSharedScripts,
      sharedSkills: tmpSharedSkills,
      rulesSupportedMap,
      step: () => {},
      ok: () => {},
    });

    // 2. 共有スクリプトのミラーリング
    installScripts({
      scriptsDir: path.join(ROOT, 'scripts'),
      sharedScripts: tmpSharedScripts,
      agentsYaml: agentsYamlPath,
      step: () => {},
      ok: () => {},
    });

    // 3. 共有スキルのデプロイ
    installSharedSkills(testAgents, {
      skillsDir,
      sharedSkills: tmpSharedSkills,
      sharedScripts: tmpSharedScripts,
      step: () => {},
      ok: () => {},
    });

    // ── 各エージェント宛先の検証 ──
    for (const { agentName, destDir, label } of agentDestEntries) {
      assert.ok(fs.existsSync(destDir), `宛先ディレクトリが存在しない: ${destDir} (${label})`);

      for (const skill of knownSkillNames) {
        const skillMdPath = path.join(destDir, skill, 'SKILL.md');
        assert.ok(fs.existsSync(skillMdPath), `${skill}/SKILL.md が生成されていない (${label})`);

        const content = fs.readFileSync(skillMdPath, 'utf8');

        // 未置換プレースホルダーが残っていないこと
        const unreplaced = content.match(/\{\{[^}]+\}\}/g);
        assert.ok(
          !unreplaced,
          `${label}/${skill}/SKILL.md に未置換プレースホルダーあり: ${(unreplaced || []).join(', ')}`
        );

        // node "..." で呼ばれるスクリプトパスが tmpSharedScripts 配下の絶対パスであること
        const matches = [...content.matchAll(/node\s+"([^"]+\.js)"/g)]
          .map(m => m[1])
          .filter(p => !p.startsWith('$'));
        for (const scriptPath of matches) {
          assert.ok(
            path.isAbsolute(scriptPath),
            `${label}/${skill}/SKILL.md のスクリプトパスが相対パス: "${scriptPath}"`
          );
          assert.ok(
            scriptPath.startsWith(tmpSharedScripts),
            `${label}/${skill}/SKILL.md のスクリプトパスが集約先を指していない: "${scriptPath}"`
          );
        }

        // orchestrator SKILL.md の issue template 参照が shared skills の絶対パスであること
        if (skill === 'gh-maestro-orchestrator') {
          const tmplMatch = content.match(/`([^`]+issue-template\.md)`/);
          assert.ok(tmplMatch, `${label}/gh-maestro-orchestrator/SKILL.md に issue-template.md 参照が見つからない`);
          assert.ok(
            path.isAbsolute(tmplMatch[1]),
            `${label}/gh-maestro-orchestrator/SKILL.md の issue-template 参照が相対パス: "${tmplMatch[1]}"`
          );
          assert.ok(
            tmplMatch[1].startsWith(tmpSharedSkills),
            `${label}/gh-maestro-orchestrator/SKILL.md の issue-template 参照が共有スキル先を指していない: "${tmplMatch[1]}"`
          );
        }

        // スキルディレクトリに scripts/ サブディレクトリが存在しないこと
        const perSkillScripts = path.join(destDir, skill, 'scripts');
        assert.ok(
          !fs.existsSync(perSkillScripts),
          `スクリプトは集約先に置くべきで、per-skill の scripts/ は存在してはならない: ${perSkillScripts}`
        );

        // 非orchestratorスキルに自己ポーリング専用のMonitor起動指示が含まれないこと
        if (skill !== 'gh-maestro-orchestrator') {
          assert.ok(
            !content.includes('最初のツール呼び出しとして'),
            `${label}/${skill}/SKILL.md に自己ポーリング専用のMonitor起動指示が含まれている`
          );
          assert.ok(
            !content.includes('persistent: true'),
            `${label}/${skill}/SKILL.md にMonitor専用の persistent: true 指示が含まれている`
          );
        }
      }
    }

    const reviewerPhaseFiles = ['phase1-planning.md', 'phase2-integration.md'];
    for (const { destDir, label } of agentDestEntries) {
      for (const file of reviewerPhaseFiles) {
        const distributedPath = path.join(destDir, 'gh-maestro-reviewer', file);
        assert.ok(fs.existsSync(distributedPath), `${label}/gh-maestro-reviewer/${file} が生成されていない`);
        assert.equal(
          fs.readFileSync(distributedPath, 'utf8'),
          fs.readFileSync(path.join(skillsDir, 'gh-maestro-reviewer', file), 'utf8')
            .replaceAll('{{SHARED_SKILLS_PATH}}', tmpSharedSkills)
            .replaceAll('{{SCRIPTS_PATH}}', tmpSharedScripts),
          `${label}/gh-maestro-reviewer/${file} の内容が正本と一致しない`
        );
      }
    }

    // ── 共有スキルの検証 ──
    const templatePath = path.join(tmpSharedSkills, 'gh-maestro-orchestrator', 'issue-template.md');
    assert.ok(fs.existsSync(templatePath), `共有スキル配布先に issue-template.md が存在しない: ${templatePath}`);

    for (const skill of knownSkillNames) {
      const skillMdPath = path.join(tmpSharedSkills, skill, 'SKILL.md');
      assert.ok(fs.existsSync(skillMdPath), `共有スキル ${skill}/SKILL.md が存在しない`);
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const unreplaced = content.match(/\{\{[^}]+\}\}/g);
      assert.ok(
        !unreplaced,
        `共有スキル ${skill}/SKILL.md に未置換プレースホルダーあり: ${(unreplaced || []).join(', ')}`
      );
    }

    for (const file of reviewerPhaseFiles) {
      const distributedPath = path.join(tmpSharedSkills, 'gh-maestro-reviewer', file);
      assert.ok(fs.existsSync(distributedPath), `共有スキル gh-maestro-reviewer/${file} が存在しない`);
      assert.equal(
        fs.readFileSync(distributedPath, 'utf8'),
        fs.readFileSync(path.join(skillsDir, 'gh-maestro-reviewer', file), 'utf8')
          .replaceAll('{{SHARED_SKILLS_PATH}}', tmpSharedSkills)
          .replaceAll('{{SCRIPTS_PATH}}', tmpSharedScripts),
        `共有スキル gh-maestro-reviewer/${file} の内容が正本と一致しない`
      );
    }

    // ── 共有スクリプトの検証 ──
    for (const name of [
      'msg-send.js',
      'shared/agent-exec.js',
      'shared/agent-launch.js',
      'shared/child-process.js',
      'shared/finalize-council.js',
      'shared/git-worktree.js',
      'shared/kill-tree.js',
      'shared/link-node-modules.js',
      'shared/resolve-agent.js',
      'shared/run-council-jobs.js',
      'shared/unlink-junctions.js',
      'shared/win-path.js',
      'shared/worker-entry.js',
      'spawn-worker.js',
      'start-review-manager.js',
      'poll-pr.js',
      'review-publisher.js',
      'print-review-leaves.js',
    ]) {
      const p = path.join(tmpSharedScripts, name);
      assert.ok(fs.existsSync(p), `集約先にスクリプトが存在しない: ${p}`);
    }

    const distributedAgentsYaml = path.join(tmpSharedScripts, 'agents.yaml');
    assert.ok(fs.existsSync(distributedAgentsYaml), `集約先に agents.yaml が存在しない: ${distributedAgentsYaml}`);
    const parsed = parseAgentsYaml(fs.readFileSync(distributedAgentsYaml, 'utf8'));
    assert.ok(parsed && typeof parsed === 'object', 'agents.yaml が正常にパースできる');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
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

