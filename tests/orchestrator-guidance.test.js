'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withTempDir: withSharedTempDir } = require('../scripts/shared/temp-directory');

const {
  resolveGuidanceDirectory,
  prepareScriptGuidance,
  extractNotificationNames,
  renderNotificationGuidance,
} = require('../scripts/shared/orchestrator-guidance');

function withTempDir(fn) {
  return withSharedTempDir('ghm-guidance-', fn);
}

function writeGuide(directory, filename, signals, body) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), [
    '---', 'signals:', ...signals.map((signal) => `  - ${signal}`), '---', body, '',
  ].join('\n'), 'utf8');
}

test('通知名はtask-notification内のevent行から抽出し、同名はまとめる', () => {
  assert.deepEqual(
    [...extractNotificationNames('<task-notification><event>PR_MERGED:9\nPR_PUSH:abc\nPR_MERGED:10</event></task-notification>')],
    ['PR_MERGED', 'PR_PUSH'],
  );
  assert.deepEqual([...extractNotificationNames('<task-notification><summary>PR_MERGED</summary></task-notification>')], []);
});

test('通知は宣言された全手順書を一度ずつ追加文脈へ出し、未宣言イベントは出さない', () => {
  withTempDir((root) => {
    writeGuide(root, 'stage8.md', ['notify:PR_MERGED'], '# stage 8');
    writeGuide(root, 'stage9.md', ['notify:PR_MERGED'], '# stage 9');
    writeGuide(root, 'retro.md', ['notify:PR_MERGED'], '# retro');
    writeGuide(root, 'other.md', ['notify:PR_COMMENT'], '# triage');
    const output = renderNotificationGuidance({
      workspace: root,
      skillDirectory: root,
      prompt: '<task-notification><event>PR_MERGED:1\nUNKNOWN_EVENT:2</event></task-notification>',
    });
    assert.match(output, /# stage 8/);
    assert.match(output, /# stage 9/);
    assert.match(output, /# retro/);
    assert.doesNotMatch(output, /# triage/);
    assert.equal((output.match(/# stage 8/g) || []).length, 1);
  });
});

test('PR_MERGEDで届く3手順書の実際の追加文脈が9000文字以下', () => {
  const skillDirectory = path.resolve(__dirname, '..', 'skills', 'gh-maestro-orchestrator');
  const output = renderNotificationGuidance({
    workspace: path.dirname(path.dirname(skillDirectory)),
    skillDirectory,
    prompt: '<task-notification><event>PR_MERGED:42</event></task-notification>',
  });
  assert.ok(output.length > 0);
  assert.ok(output.length <= 9000, `PR_MERGED追加文脈が上限超過: ${output.length}`);
  for (const filename of ['stage-8-deployment-check.md', 'stage-9-retrospective.md', 'retrospective.md']) {
    assert.match(output, new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('triage.mdは正式レビュー通知で届き、テスト結果コメントPR_COMMENTでは届かない', () => {
  const skillDirectory = path.resolve(__dirname, '..', 'skills', 'gh-maestro-orchestrator');
  const notify = (event) => renderNotificationGuidance({
    workspace: path.dirname(path.dirname(skillDirectory)),
    skillDirectory,
    prompt: `<task-notification><event>${event}:42</event></task-notification>`,
  });
  const expectedHeading = '# レビューコメントのトリアージ手順（参照専用）';

  for (const event of ['REVIEW_COMMENT', 'PR_REVIEW']) {
    assert.ok(notify(event).includes(expectedHeading), `${event} delivers triage.md`);
  }
  assert.equal(notify('PR_COMMENT'), '', 'test-result and other ordinary PR comments do not repeat triage guidance');
});

test('script合図付きCLIの手順書例はstdoutを変数・pipe・redirectで飲み込まない', () => {
  const skillsDirectory = path.resolve(__dirname, '..', 'skills');
  const collectMarkdownFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(target);
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : [];
  });
  const markdownFiles = collectMarkdownFiles(skillsDirectory);
  const commands = [];

  for (const filename of markdownFiles) {
    const markdown = fs.readFileSync(filename, 'utf8');
    const blocks = [...markdown.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
    for (const block of blocks) {
      let pending = '';
      for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const continued = /(?:\\|`)\s*$/.test(line);
        pending += `${line.replace(/(?:\\|`)\s*$/, '')} `;
        if (!continued) {
          if (pending.includes('--guidance-signal')) commands.push({ filename, command: pending.trim(), block });
          pending = '';
        }
      }
      if (pending.includes('--guidance-signal')) commands.push({ filename, command: pending.trim(), block });
    }
  }

  assert.ok(commands.length > 0, 'finds the declared CLI examples with a guidance signal');
  for (const { filename, command, block } of commands) {
    assert.match(command, /^node\s+/, `${filename} invokes the signaled CLI directly`);
    assert.doesNotMatch(command, /\$\(/, `${filename} does not capture CLI output in command substitution`);
    assert.doesNotMatch(command, /\|/, `${filename} does not pipe away CLI output`);
    const hasStdoutRedirect = /(?:^|\s)(?:\d?>|>>|&>)\s*/.test(command);
    if (hasStdoutRedirect) {
      const redirectedFile = command.match(/(?:^|\s)>(?:\s*)["']?(\$[A-Za-z_][A-Za-z_0-9]*)/);
      assert.ok(redirectedFile, `${filename} redirects only to an output file that can be replayed`);
      const replayIndex = block.indexOf(`cat "${redirectedFile[1]}"`);
      assert.ok(replayIndex >= 0, `${filename} prints redirected CLI output back to stdout`);
      assert.ok(replayIndex > block.indexOf('--guidance-signal'), `${filename} replays the output after running the CLI`);
    }
  }
});

test('script合図は一致する宣言だけを読みorchestrator identityを要求する', () => {
  withTempDir((root) => {
    writeGuide(root, 'stage2.md', ['script:create-issue.js:implementation-issue'], '# stage 2');
    const options = { workspace: root, scriptName: 'create-issue.js', signal: 'implementation-issue', skillDirectory: root };
    assert.match(prepareScriptGuidance({ ...options, env: { GH_MAESTRO_WORKER: 'orchestrator' } }), /# stage 2/);
    assert.match(prepareScriptGuidance({ ...options, env: {} }), /# stage 2/, '通常のorchestrator shellではidentity envが無い場合も明示合図を使える');
    assert.throws(() => prepareScriptGuidance({ ...options, env: { GH_MAESTRO_WORKER: 'issue-5-coder' } }), /workerが実行/);
    assert.throws(() => prepareScriptGuidance({ ...options, env: { GH_MAESTRO_WORKER: 'orchestrator' }, signal: 'other' }), /宣言された手順書合図がありません/);
    assert.throws(() => prepareScriptGuidance({ ...options, env: { GH_MAESTRO_WORKER: 'orchestrator' }, signal: '' }), /英数字/);
    assert.equal(prepareScriptGuidance({ workspace: root, scriptName: 'create-issue.js', env: { GH_MAESTRO_WORKER: 'orchestrator' }, skillDirectory: root }), '');
  });
});

test('project-local skillがあればinstalled fallbackより優先する', () => {
  withTempDir((root) => {
    const local = path.join(root, '.claude', 'skills', 'gh-maestro-orchestrator');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'SKILL.md'), '# project copy', 'utf8');
    assert.equal(resolveGuidanceDirectory(root, {
      resolveSkillMdPathFn: () => { throw new Error('fallback must not be read'); },
    }), local);
  });
});

test('installed skill path is used only when project-local skill is absent', () => {
  withTempDir((root) => {
    const installed = path.join(root, 'installed', 'gh-maestro-orchestrator', 'SKILL.md');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '# installed copy', 'utf8');
    assert.equal(resolveGuidanceDirectory(root, { resolveSkillMdPathFn: () => installed }), path.dirname(installed));
  });
});
