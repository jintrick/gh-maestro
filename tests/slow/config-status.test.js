'use strict';

// config.js の `status` サブコマンドは、スキルごとに解決したエージェントコマンドを
// checkAgentExists()（scripts/agent-exec.js）で実在確認する。Windows では未知コマンド
// 1件につき pwsh を最大2回起動するため、config.js status を実サブプロセスとして
// 起動するテストは1件あたり数十秒かかる（デフォルト `npm test` の総実行時間の大半を
// 占めていた）。デフォルトの `npm test`（tests/*.test.js）からは除外し、
// `npm run test:slow` でのみ実行する。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadJSON } = require('../../scripts/config');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'config.js');

// ── helpers（tests/config.test.js と同型。共有せず意図的に複製し、
//    このファイル単体で `npm run test:slow` として実行できるようにする） ──────

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-config-test-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(home, data) {
  fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-config-ws-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeWorkspaceConfig(ws, data) {
  fs.writeFileSync(
    path.join(ws, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

function runConfig(args, home, cwd) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.GH_MAESTRO_WORKSPACE;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: cwd || os.tmpdir(),
    env,
    encoding: 'utf8',
  });
}

// ── CLI integration: status ────────────────────────────────────────────────────

test('CLI status: デフォルトマップを表示できる', () => {
  withTempHome(home => {
    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('gh-maestro-coder'), 'includes coder skill');
    assert.ok(r.stdout.includes('gh-maestro-explorer'), 'includes explorer skill');
    assert.ok(r.stdout.includes('default'), 'includes source column');
  });
});

test('CLI status: global override されたエントリのソースが表示される', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'agy' },
    });

    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('global'), 'includes global source');
  });
});

test('CLI status: workspace override の command/extraArgs 警告を表示する', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      writeWorkspaceConfig(ws, {
        agents: {
          'claude-ds': { command: 'evil', extraArgs: ['--bad'] },
        },
      });

      const r = runConfig(['status', '--workspace', ws], home);
      assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
      assert.ok(
        r.stdout.includes('IGNORED'),
        `should warn about ignored overrides: ${r.stdout}`,
      );
      assert.ok(r.stdout.includes('claude-ds'), 'should mention agent id');
    });
  });
});

test('CLI status: workspace override の execArgs 警告も表示する（PR #103 Review Manager指摘）', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      writeWorkspaceConfig(ws, {
        agents: {
          codex: { execArgs: ['exec', '--sandbox', 'danger-full-access'] },
        },
      });

      const r = runConfig(['status', '--workspace', ws], home);
      assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
      assert.ok(
        r.stdout.includes('IGNORED') && r.stdout.includes('execArgs'),
        `should warn about ignored execArgs override: ${r.stdout}`,
      );
      assert.ok(r.stdout.includes('codex'), 'should mention agent id');
    });
  });
});

test('CLI status: workspace なしでは workspace config 警告は出ない', () => {
  withTempHome(home => {
    writeConfig(home, {});
    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(!r.stdout.includes('IGNORED'), 'should not mention IGNORED without workspace');
  });
});

test('CLI status: config.json がない場合でもデフォルトマップを表示する', () => {
  withTempHome(home => {
    // No config.json written
    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('gh-maestro-coder'), 'includes default map');
  });
});

test('CLI status: グローバル設定に未知のスキルキーがある場合に警告する', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-review-manager': 'codex' },
    });

    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    const stdoutStr = String(r.stdout);
    assert.ok(stdoutStr.includes('[WARN]'), `stdout missing [WARN]: ${stdoutStr}`);
    assert.ok(stdoutStr.includes('Unknown skill key'), `stdout missing 'Unknown skill key': ${stdoutStr}`);
    assert.ok(stdoutStr.includes('gh-maestro-review-manager'), `stdout missing 'gh-maestro-review-manager': ${stdoutStr}`);
  });
});

test('CLI status: プロファイル内の未知のスキルキーを警告する', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        bad: { skillAgentMap: { 'gh-maestro-review-manager': 'codex' } },
      },
    });

    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    const stdoutStr = String(r.stdout);
    assert.ok(stdoutStr.includes('[WARN]'), `stdout missing [WARN]: ${stdoutStr}`);
    assert.ok(stdoutStr.includes('Unknown skill key'), `stdout missing 'Unknown skill key': ${stdoutStr}`);
    assert.ok(stdoutStr.includes('gh-maestro-review-manager'), `stdout missing key: ${stdoutStr}`);
    assert.ok(stdoutStr.includes('bad'), `stdout missing profile name: ${stdoutStr}`);
  });
});

test('CLI status: パース不能な config でもデフォルトマップは表示する', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '{ corrupt', 'utf8');

    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('gh-maestro-coder'), 'includes default map despite parse error');
  });
});

test('Profile semantics: プロファイルはデフォルトに対する差分として機能する', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        partial: { skillAgentMap: { 'gh-maestro-coder': 'codex' } },
      },
    });

    // Apply partial profile
    let r = runConfig(['use', 'partial'], home);
    assert.equal(r.status, 0, r.stderr);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'codex' });

    // Now check status: only coder skill is overridden, rest are defaults
    r = runConfig(['status'], home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('gh-maestro-base'), 'base should still be resolved from defaults');
  });
});

test('CLI: --workspace flag が正しく解析される', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      writeWorkspaceConfig(ws, {
        skillAgentMap: { 'gh-maestro-coder': 'codex' },
      });

      const r = runConfig(['status', '--workspace', ws], home);
      assert.equal(r.status, 0, r.stderr);
      // The workspace value should override the skill map
      assert.ok(r.stdout.includes('workspace'), 'should show workspace source');
    });
  });
});

test('CLI: --workspace の後に値がない場合はデフォルト解決', () => {
  withTempHome(home => {
    writeConfig(home, {});
    // --workspace の後ろに値が来ず、次の引数が不明なフラグの場合
    const r = runConfig(['status', '--workspace'], home);
    assert.equal(r.status, 0, `status exit 0, stderr: ${r.stderr}`);
  });
});
