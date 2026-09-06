'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  loadJSON,
  collectValidAgentIds,
  closestKnownSkillKey,
  resolveSkillAgentMapWithSources,
  validateConfig,
  validateCouncilConfig,
  USAGE,
} = require('../../scripts/config');

const { loadDefaults } = require('../../scripts/shared/resolve-config');

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

// ── loadJSON ───────────────────────────────────────────────────────────────────






// ── collectValidAgentIds ───────────────────────────────────────────────────────





// ── closestKnownSkillKey ──────────────────────────────────────────────────────────








// ── resolveSkillAgentMapWithSources ─────────────────────────────────────────────





// ── validateConfig ─────────────────────────────────────────────────────────────




























// ── CLI integration: --help ────────────────────────────────────────────────────

test('CLI: --help は usage を表示し exit 0', () => {
  withTempHome(home => {
    const r = runConfig(['--help'], home);
    assert.equal(r.status, 0, `exit 0, got ${r.status}, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('config.js'), 'stdout should include script name');
    assert.ok(r.stdout.includes('use'), 'stdout should mention use subcommand');
    assert.ok(r.stdout.includes('status'), 'stdout should mention status subcommand');
    assert.ok(r.stdout.includes('doctor'), 'stdout should mention doctor subcommand');
  });
});

test('CLI: -h も同様', () => {
  withTempHome(home => {
    const r = runConfig(['-h'], home);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('config.js'));
  });
});

test('CLI: サブコマンドなしは usage を stderr に出して exit 1', () => {
  withTempHome(home => {
    const r = runConfig([], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('config.js'), 'stderr should include usage');
  });
});

test('CLI: 不明なサブコマンドはエラーで exit 1', () => {
  withTempHome(home => {
    const r = runConfig(['unknown-subcommand'], home);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('unknown'), 'stderr mentions unknown');
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
    assert.ok(
      r.stderr.includes('not found') || r.stderr.includes('no-such-agent'),
      `stderr should mention bad agent: ${r.stderr}`,
    );
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

// CLI status の実サブプロセス統合テストは tests/slow/config-status.test.js
// （`npm run test:slow`）に分離した。checkAgentExists() が未知コマンド1件につき
// pwshを最大2回起動するため、デフォルトの `npm test` に含めると1テストあたり
// 数十秒かかっていた。

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
      assert.ok(
        r.stdout.includes('[WARN]') || r.stdout.includes('workspace'),
        `should include workspace issues: ${r.stdout}`,
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

// ── saveConfig ─────────────────────────────────────────────────────────────────

test('saveConfig: 設定を書き込める', () => {
  withTempHome(home => {
    const { saveConfig } = require('../../scripts/config');
    const configPath = path.join(home, '.gh-maestro', 'config.json');
    // Override CONFIG_PATH for this test — can't directly, so test via use CLI
    writeConfig(home, {
      profiles: {
        test: { skillAgentMap: { 'gh-maestro-coder': 'claude' } },
      },
    });

    const r = runConfig(['use', 'test'], home);
    assert.equal(r.status, 0, r.stderr);

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.skillAgentMap, { 'gh-maestro-coder': 'claude' });
    assert.ok(saved.profiles, 'profiles preserved');
  });
});

test('saveConfig: 新規ファイルを作成できる', () => {
  withTempHome(home => {
    // Remove .gh-maestro dir
    fs.rmSync(path.join(home, '.gh-maestro'), { recursive: true, force: true });

    writeConfig(home, {
      profiles: {
        test: { skillAgentMap: { 'gh-maestro-coder': 'claude' } },
      },
    });

    // writeConfig creates .gh-maestro dir — now use a profile
    const r = runConfig(['use', 'test'], home);
    assert.equal(r.status, 0, r.stderr);

    const configPath = path.join(home, '.gh-maestro', 'config.json');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.skillAgentMap, { 'gh-maestro-coder': 'claude' });
  });
});

// ── Profile differential semantics ─────────────────────────────────────────────

// 'Profile semantics: プロファイルはデフォルトに対する差分として機能する' は
// config.js status を呼ぶため tests/slow/config-status.test.js に移動した。

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

test('Profile semantics: 壊れた skillAgentMap（プレーンオブジェクト以外）があってもプロファイル適用時に修復される', () => {
  withTempHome(home => {
    // 1. skillAgentMap が文字列になっている（無効）
    writeConfig(home, {
      skillAgentMap: 'corrupted-string-value',
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    let r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0, r.stderr);

    let config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy' });

    // 2. skillAgentMap が配列になっている（無効）
    writeConfig(home, {
      skillAgentMap: ['array', 'is', 'invalid'],
      profiles: {
        peak: { skillAgentMap: { 'gh-maestro-coder': 'agy' } },
      },
    });

    r = runConfig(['use', 'peak'], home);
    assert.equal(r.status, 0, r.stderr);

    config = loadJSON(path.join(home, '.gh-maestro', 'config.json'));
    assert.deepEqual(config.skillAgentMap, { 'gh-maestro-coder': 'agy' });
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

// ── --workspace flag parsing ───────────────────────────────────────────────────

// 'CLI: --workspace flag が正しく解析される' と
// 'CLI: --workspace の後に値がない場合はデフォルト解決' は config.js status を
// 呼ぶため tests/slow/config-status.test.js に移動した。

// ── CLI integration: status の非対話化トークン警告（Issue #163） ───────────────
// 通常の status 実サブプロセステストは checkAgentExists がログインシェルを起動するため
// tests/slow/config-status.test.js に分離している。ここでは skillAgentMap の全対象
// エージェントを command=process.execPath に上書きし、checkAgentExists が同一コマンドに
// 対して1回（pwsh/bash）だけ起動するよう高速化した上で、警告出力をデフォルトの npm test
// で検証する。

test('CLI status: 非対話化トークンを欠落させたエージェントを警告する（extraArgs・execArgsの両方, Issue #163）', () => {
  withTempHome(home => {
    const mappedAgents = {
      'claude-ds': { extraArgs: ['--dangerously-skip-permissions'] }, // extraArgs の --print を欠落
      'claude-ds-pro': { extraArgs: ['--dangerously-skip-permissions'] }, // extraArgs の --print を欠落
      reasonix: { extraArgs: ['--custom-flag'] }, // run を欠落
      agy: { extraArgs: ['--dangerously-skip-permissions'] }, // nonInteractiveTokens 未宣言 → 警告対象外
      codex: { extraArgs: ['--skip-git-repo-check'], execArgs: ['--skip-git-repo-check'] }, // 両方 exec を欠落
      'codex-pro': { extraArgs: ['--skip-git-repo-check'] }, // extraArgs の exec を欠落
    };
    writeConfig(home, {
      agents: Object.fromEntries(
        Object.entries(mappedAgents).map(([id, override]) => [
          id,
          { command: process.execPath, ...override },
        ]),
      ),
    });

    const r = runConfig(['status'], home);
    assert.equal(r.status, 0, `exit 0, stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes('[WARN]'), `[WARN] が出力されること: ${r.stdout}`);
    assert.ok(
      r.stdout.includes('non-interactive token'),
      `non-interactive token に言及すること: ${r.stdout}`,
    );
    // extraArgs 側の欠落警告（通常ワーカー起動経路）
    assert.ok(
      r.stdout.includes('in extraArgs') && r.stdout.includes('claude-ds') && r.stdout.includes('--print'),
      `extraArgs の欠落警告に claude-ds / --print が含まれること: ${r.stdout}`,
    );
    // execArgs 側の欠落警告（Review Manager 起動経路。Issue #163 BLOCKER）
    assert.ok(
      r.stdout.includes('in execArgs') && r.stdout.includes('codex') && r.stdout.includes('exec'),
      `execArgs の欠落警告に codex / exec が含まれること: ${r.stdout}`,
    );
  });
});

// ── validateCouncilConfig（Issue #230） ───────────────────────────────────────












// ── validateCouncilMerged（マージ後検証。review指摘 #4/#5） ─────────────────────

/**
 * resolve-config.js の resolveCouncilConfig / resolveAgentConfig を差し替えた状態で
 * config.js を再ロードする。config.js はロード時に resolve-config の名前付きエクスポートを
 * 捕捉するため、キャッシュを消して現在のモックを反映させる。
 * @param {object} overrides  resolve-config.js の exports に対する上書き
 * @returns {object} 再ロードした config.js の module.exports
 */
function loadConfigWithResolveConfig(overrides) {
  const configPath = require.resolve('../../scripts/config');
  const resolveConfigPath = require.resolve('../../scripts/shared/resolve-config');
  const real = require(resolveConfigPath);
  delete require.cache[configPath];
  require.cache[resolveConfigPath] = {
    id: resolveConfigPath,
    filename: resolveConfigPath,
    loaded: true,
    exports: { ...real, ...overrides },
  };
  try {
    return require(configPath);
  } finally {
    delete require.cache[resolveConfigPath];
    delete require.cache[configPath];
  }
}
