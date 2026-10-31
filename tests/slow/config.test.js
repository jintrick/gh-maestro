'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadJSON } = require('../../scripts/config');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'config.js');

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Create a temp directory with a .gh-maestro dir and an empty config.
 * Returns the temp home dir path. Cleaned up automatically.
 */
function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-config-test-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write config.json into a temp home directory.
 */
function writeConfig(home, data) {
  fs.mkdirSync(path.join(home, '.gh-maestro'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

/**
 * Create a temp workspace directory.
 */
function withTempWorkspace(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghm-config-ws-'));
  try {
    fs.mkdirSync(path.join(dir, '.gh-maestro'), { recursive: true });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write workspace config into a temp workspace directory.
 */
function writeWorkspaceConfig(ws, data) {
  fs.writeFileSync(
    path.join(ws, '.gh-maestro', 'config.json'),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

/**
 * Run config.js as a subprocess with a custom HOME.
 */
function runConfig(args, home, cwd) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // Unset GH_MAESTRO_WORKSPACE so tests don't pick up the real workspace
  delete env.GH_MAESTRO_WORKSPACE;
  // Use os.tmpdir() as default cwd to avoid accidentally picking up
  // a .gh-maestro workspace directory from the home path
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: cwd || os.tmpdir(),
    env,
    encoding: 'utf8',
  });
}

// ── CLI integration: --help ────────────────────────────────────────────────────

test('CLI: --help / -h は usage を表示し exit 0', () => {
  withTempHome(home => {
    for (const flag of ['--help', '-h']) {
      const r = runConfig([flag], home);
      assert.equal(r.status, 0, `${flag}: exit 0, got ${r.status}, stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes('config.js'), `${flag}: stdout should include script name`);
      assert.ok(r.stdout.includes('use'), `${flag}: stdout should mention use subcommand`);
      assert.doesNotMatch(r.stdout, /\bstatus\b/, `${flag}: status subcommand should not appear in usage`);
      assert.ok(r.stdout.includes('doctor'), `${flag}: stdout should mention doctor subcommand`);
    }
  });
});

test('CLI: サブコマンドなしは usage を stderr に出して exit 1', () => {
  withTempHome(home => {
    const r = runConfig([], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('config.js'), 'stderr should include usage');
  });
});

test('CLI: 削除済みのstatusサブコマンドは未知として拒否する', () => {
  withTempHome(home => {
    const r = runConfig(['status'], home);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown subcommand "status"/);
  });
});

// ── CLI integration: use ───────────────────────────────────────────────────────

test('CLI use: プロファイルを適用できる', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    const r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy' });
    // 書き込み時に profiles 定義を落とさないことも確かめる（保存の欠陥を検出する）
    assert.ok(config.profiles, 'profiles preserved after use');
    assert.ok(r.stdout.includes('peak'), 'stdout includes profile name');
  });
});

test('CLI use: プロファイル名がない場合はエラー', () => {
  withTempHome(home => {
    const r = runConfig(['use'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('profile name required'), r.stderr);
  });
});

test('CLI use: 存在しないプロファイルはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    const r = runConfig(['use', 'nonexistent'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('not found'), r.stderr);
    assert.ok(r.stderr.includes('peak'), 'should list available profiles');
  });
});

test('CLI use: プロファイルがない状態で use すると利用可能一覧なし', () => {
  withTempHome(home => {
    writeConfig(home, {});

    const r = runConfig(['use', 'any'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('No profiles defined'), r.stderr);
  });
});

test('CLI use: プロファイルの skillAgentMap が空オブジェクトはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        bad: { skillAgentMap: {} },
      },
    });

    const r = runConfig(['use', 'bad'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('no valid skillAgentMap'), r.stderr);
  });
});

test('CLI use: 未知のエージェントID を含むプロファイルはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        bad: { skillAgentMap: { 'gh-maestro-coder': 'no-such-agent' } },
      },
    });

    const r = runConfig(['use', 'bad'], home);
    assert.notEqual(r.status, 0);
    // 実際のエラー形式（"[ERROR]" タグは無い）: 不明なエージェントIDを名指しして not found と報告する
    assert.match(r.stderr, /agent ID "no-such-agent".*not found/, `stderr: ${r.stderr}`);
  });
});

test('CLI use: カスタムエージェントをプロファイルで参照できる', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'my-agent': { command: 'my-cli', promptDelivery: 'flag' },
      },
      profiles: {
        custom: { skillAgentMap: { 'gh-maestro-coder': 'my-agent' } },
      },
    });

    const r = runConfig(['use', 'custom'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'my-agent' });
  });
});

test('CLI use: extendsで既存エージェントを継承するカスタムエージェントをプロファイルで参照できる（agent-defaults.jsonへの追記不要）', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'codex-terra': { extends: 'codex', command: 'codex-terra' },
      },
      profiles: {
        custom: { skillAgentMap: { 'gh-maestro-reviewer': 'codex-terra' } },
      },
    });

    const r = runConfig(['use', 'custom'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-reviewer': 'codex-terra' });
  });
});

test('CLI use: 既存デフォルトのagentId（例: codex）を壊れたextendsで上書きしたプロファイルはエラーになる（PR #170レビュー指摘）', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        codex: { extends: 'no-such-agent' },
      },
      profiles: {
        custom: { skillAgentMap: { 'gh-maestro-reviewer': 'codex' } },
      },
    });

    const r = runConfig(['use', 'custom'], home);
    assert.notEqual(r.status, 0, 'defaultAgentIdsに存在するagentIdでも壊れたextendsはエラーにすべき');
    assert.ok(r.stderr.includes('codex') && r.stderr.includes('extends'), r.stderr);
  });
});

test('CLI use: 既存のエージェント設定は保持される', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'claude-ds': { command: 'pwsh' },
      },
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    const r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy' });
    assert.ok(config.agents, 'agents section preserved');
    assert.ok(config.agents['claude-ds'], 'claude-ds override preserved');
  });
});

test('CLI use: プロファイル適用で前の skillAgentMap を上書きマージする', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'codex', 'gh-maestro-base': 'codex' },
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    // Apply peak
    let r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0);

    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy', 'gh-maestro-base': 'codex' });
  });
});

// ── CLI integration: doctor ────────────────────────────────────────────────────

test('CLI doctor: 正常な config は OK を表示する', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'claude-ds' } },
      },
    });

    const r = runConfig(['doctor'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('OK'), `should say OK: ${r.stdout}`);
  });
});

test('CLI doctor: config がない場合も OK を表示する', () => {
  withTempHome(home => {
    // No config.json
    const r = runConfig(['doctor'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('OK'), 'no config is OK');
  });
});

test('CLI doctor: パースエラーは exit code 1 で報告する', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '{ bad json', 'utf8');

    const r = runConfig(['doctor'], home);
    assert.notEqual(r.status, 0, `should fail: ${r.status}`);
    assert.ok(r.stdout.includes('[ERROR]'), 'should include ERROR');
  });
});

test('CLI doctor: 未知のエージェントID は警告する', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'no-such-agent' },
    });

    const r = runConfig(['doctor'], home);
    assert.ok(
      r.stdout.includes('[WARN]') && r.stdout.includes('no-such-agent'),
      `should warn: ${r.stdout}`,
    );
  });
});

test('CLI doctor: 不完全なカスタムエージェントはエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      agents: {
        'incomplete': { label: 'No command or delivery' },
      },
    });

    const r = runConfig(['doctor'], home);
    assert.notEqual(r.status, 0, 'should exit with error');
    assert.ok(
      r.stdout.includes('[ERROR]') && r.stdout.includes('incomplete'),
      `should report incomplete agent: ${r.stdout}`,
    );
  });
});

test('CLI doctor: プロファイルの空 skillAgentMap はエラー', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        empty: { skillAgentMap: {} },
      },
    });

    const r = runConfig(['doctor'], home);
    assert.notEqual(r.status, 0, 'should exit with error');
    assert.ok(
      r.stdout.includes('[ERROR]') && r.stdout.includes('empty'),
      `should report empty profile: ${r.stdout}`,
    );
  });
});

test('CLI doctor: workspace config も検証する', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      writeWorkspaceConfig(ws, { skillAgentMap: { 'x': 'bad-agent' } });

      const r = runConfig(['doctor', '--workspace', ws], home);
      // global は空なので、bad-agent の指摘は workspace 検証からしか出ない
      assert.ok(
        r.stdout.includes('[WARN]') && r.stdout.includes('bad-agent'),
        `should report workspace bad-agent as [WARN]: ${r.stdout}`,
      );
    });
  });
});

test('CLI doctor: workspace config のパースエラーを報告する', () => {
  withTempHome(home => {
    withTempWorkspace(ws => {
      writeConfig(home, {});
      fs.writeFileSync(path.join(ws, '.gh-maestro', 'config.json'), '{ bad', 'utf8');

      const r = runConfig(['doctor', '--workspace', ws], home);
      assert.notEqual(r.status, 0, 'workspace parse error should fail');
      assert.ok(
        r.stdout.includes('[ERROR]') && r.stdout.includes('workspace'),
        `should report workspace error: ${r.stdout}`,
      );
    });
  });
});

test('CLI doctor: 未知のスキルキーを警告する', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-review-manager': 'codex' },
    });

    const r = runConfig(['doctor'], home);
    // WARN は exit code 1 にしない（doctor は exit code 1 だが、他の issue による）
    // ただし警告メッセージが出力されること
    assert.ok(
      r.stdout.includes('unknown skill key') && r.stdout.includes('gh-maestro-review-manager'),
      `should warn about unknown skill key: ${r.stdout}`,
    );
  });
});

test('CLI doctor: プロファイル内の未知のスキルキーを警告する', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        bad: { skillAgentMap: { 'gh-maestro-review-manager': 'codex' } },
      },
    });

    const r = runConfig(['doctor'], home);
    assert.ok(
      r.stdout.includes('unknown skill key') && r.stdout.includes('bad'),
      `should warn about unknown skill key in profile: ${r.stdout}`,
    );
  });
});

// ── Profile differential semantics ─────────────────────────────────────────────

test('Profile semantics: プロファイルの重ね掛け（スタック適用）ができる', () => {
  withTempHome(home => {
    writeConfig(home, {
      profiles: {
        peak: {
          skillAgentMap: {
            'gh-maestro-coder': 'agy',
            'gh-maestro-explorer': 'claude',
          },
        },
        'avoid-codex': {
          skillAgentMap: {
            'gh-maestro-explorer': 'claude-ds',
          },
        },
      },
    });

    // 1. peakプロファイルを適用
    let r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0, r.stderr);

    let config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, {
      'gh-maestro-coder': 'agy',
      'gh-maestro-explorer': 'claude',
    });

    // 2. avoid-codexプロファイルを重ね掛けで適用
    r = runConfig(['use', 'avoid-codex'], home);
    assert.equal(r.status, 0, r.stderr);

    config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, {
      'gh-maestro-coder': 'agy',
      'gh-maestro-explorer': 'claude-ds',
    });
  });
});

// 壊れた config.json は書き換えない（ADR 0053）。use は止まり、ファイルのバイト列は変わらない。
test('Profile semantics: skillAgentMap が文字列のとき use は終了コード1で止まり、ファイルを書き換えず、箇所を示す', () => {
  withTempHome(home => {
    const configPath = path.join(home, '.gh-maestro', 'config.json');
    writeConfig(home, {
      skillAgentMap: 'corrupted-string-value',
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });
    const before = fs.readFileSync(configPath, 'utf8');

    const r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.ok(r.stderr.includes('skillAgentMap'), `stderr must name the key: ${r.stderr}`);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'config.json must not be rewritten');
  });
});

test('Profile semantics: skillAgentMap が配列のとき use は終了コード1で止まり、ファイルを書き換えない', () => {
  withTempHome(home => {
    const configPath = path.join(home, '.gh-maestro', 'config.json');
    writeConfig(home, {
      skillAgentMap: ['array', 'is', 'invalid'],
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });
    const before = fs.readFileSync(configPath, 'utf8');

    const r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'config.json must not be rewritten');
  });
});

test('Profile semantics: JSON 構文エラーの config.json では use は終了コード1で止まり、ファイルを書き換えない', () => {
  withTempHome(home => {
    const configPath = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(configPath, '{ "profiles": { "peak": ', 'utf8');
    const before = fs.readFileSync(configPath, 'utf8');

    const r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before, 'config.json must not be rewritten');
  });
});

test('CLI use: 未知のスキルキーを含むプロファイルは警告するが適用は成功する', () => {
  withTempHome(home => {
    writeConfig(home, {
      skillAgentMap: { 'gh-maestro-coder': 'claude-ds' },
      profiles: {
        bad: { skillAgentMap: { 'gh-maestro-review-manager': 'codex' } },
      },
    });

    const r = runConfig(['use', 'bad'], home);
    // 正常終了（unknown key は警告のみ）
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    // 警告が stderr に出ている
    assert.ok(
      r.stderr.includes('[WARN]') && r.stderr.includes('unknown skill key') && r.stderr.includes('gh-maestro-review-manager'),
      `stderr should warn about unknown skill key: ${r.stderr}`,
    );
    // 適用は成功している
    const config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.ok(config.skillAgentMap['gh-maestro-review-manager']);
  });
});

// ── Config parse error handling ────────────────────────────────────────────────

test('CLI use: パース不能な config の場合はエラー', () => {
  withTempHome(home => {
    const p = path.join(home, '.gh-maestro', 'config.json');
    fs.writeFileSync(p, '{ corrupt', 'utf8');

    const r = runConfig(['use', 'any'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('cannot parse'), r.stderr);
  });
});
