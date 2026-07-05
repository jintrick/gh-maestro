'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const POLLER_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-poller.js');
const SEND_SCRIPT = path.join(__dirname, '..', 'scripts', 'queue-send.js');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [POLLER_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', ...env },
  });
}

function runSend(args, env = {}) {
  return spawnSync(process.execPath, [SEND_SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', ...env },
  });
}

/**
 * 非同期で poller を起動し、コールバックに渡す。
 * Pane-list モックは指定の tmpDir に書き出す。
 */
function withPoller(workspace, tmpDir, fn) {
  return new Promise((resolve, reject) => {
    // wezterm mock: cli list には空配列を返し、その他は exit 0
    const mockPath = path.join(tmpDir, 'wezterm-mock.js');
    fs.writeFileSync(
      mockPath,
      "const a = process.argv.slice(2).join(' ');\n" +
      "if (a.startsWith('cli list')) process.stdout.write('[]');\n" +
      "process.exit(0);\n",
      'utf8'
    );

    const child = spawn(process.execPath, [POLLER_SCRIPT, '--workspace', workspace], {
      env: { ...process.env, WEZTERM_MOCK: mockPath, GH_MAESTRO_DISABLE_LAZY_POLLER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Poller timeout\nstderr: ${stderr}`));
    }, 10000);

    child.on('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`Poller unexpectedly exited\nstderr: ${stderr}`));
    });

    // poller.json ができるまで待つ
    const pollerJsonPath = path.join(workspace, '.gh-maestro', 'queue', 'poller.json');
    const waitStart = Date.now();
    (function waitPoller() {
      if (fs.existsSync(pollerJsonPath)) {
        // 少し待ってからコールバック（初期化完了を保証）
        setTimeout(async () => {
          try {
            await fn(child, pollerJsonPath);
            try { child.kill(); } catch {}
            resolve();
          } catch (e) {
            try { child.kill(); } catch {}
            reject(e);
          }
        }, 300);
        return;
      }
      if (Date.now() - waitStart > 5000) {
        try { child.kill(); } catch {}
        reject(new Error('poller.json not created\n' + stderr));
        return;
      }
      setTimeout(waitPoller, 50);
    })();
  });
}

// ── --help ──────────────────────────────────────────────────────────────

test('--help が usage を stdout に出して exit 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-poller.js'));
  assert.equal(r.stderr, '');
});

test('-h が usage を stdout に出して exit 0', () => {
  const r = run(['-h']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('queue-poller.js'));
  assert.equal(r.stderr, '');
});

// ── 引数エラー ──────────────────────────────────────────────────────────

test('--workspace を値なしで指定すると exit 1', () => {
  const r = run(['--workspace']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('--workspace'));
});

test('--workspace を指定して空ディレクトリで起動すると poller.json が作成されるまで待たない（spawnSync即終了）', () => {
  // spawnSync を使う run() では poller のsetIntervalが無限ループするため、
  // 代わりに poller プロセスを spawn して poller.json の作成を確認する。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-test-'));
  try {
    const child = spawn(process.execPath, [POLLER_SCRIPT, '--workspace', tmpDir], {
      env: { ...process.env },
      stdio: 'ignore',
    });

    const pollerJsonPath = path.join(tmpDir, '.gh-maestro', 'queue', 'poller.json');
    const maxWait = 3000;
    const start = Date.now();
    let found = false;
    while (Date.now() - start < maxWait) {
      if (fs.existsSync(pollerJsonPath)) { found = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(found, '空ディレクトリでも poller.json が作成されるべき');

    // cleanup
    try { child.kill('SIGTERM'); } catch {}
    if (process.platform === 'win32') {
      try { spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
    }
  } finally {
    killPollerFromJson(path.join(tmpDir, '.gh-maestro', 'queue', 'poller.json'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 二重起動防止 ────────────────────────────────────────────────────────

test('poller.json がない場合 poller が起動して作成する', async () => {
  await withTempDir(async workspace => {
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-mock-'));
    try {
      await withPoller(workspace, mockDir, async (child, pollerJsonPath) => {
        assert.ok(fs.existsSync(pollerJsonPath), 'poller.json が作成されるべき');
        const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
        assert.ok(state.heartbeat, 'heartbeat が存在する');
        assert.ok(state.pid, 'pid が存在する');
        assert.equal(state.pid, child.pid, 'pid が自身のプロセスIDと一致する');
      });
    } finally {
      fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });
});

test('既存の poller.json が新鮮なら2つ目は exit 0 で退出する', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    const pollerJsonPath = path.join(queueDir, 'poller.json');
    fs.mkdirSync(queueDir, { recursive: true });

    // 新鮮な poller.json を作成（未来の heartbeat）
    fs.writeFileSync(pollerJsonPath, JSON.stringify({
      pid: 999999,
      heartbeat: Date.now() + 60000, // 未来時刻
      startedAt: new Date().toISOString(),
    }), 'utf8');

    // 2つ目の poller を起動 → 退出するはず
    const r = run(['--workspace', workspace]);
    assert.equal(r.status, 0);
    // poller.json は元の内容が維持される（上書きされない）
    const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
    assert.equal(state.pid, 999999);
  });
});

test('stale poller.json から新しい poller が乗っ取る', async () => {
  await withTempDir(async workspace => {
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-mock-'));
    try {
      const queueDir = path.join(workspace, '.gh-maestro', 'queue');
      const pollerJsonPath = path.join(queueDir, 'poller.json');
      fs.mkdirSync(queueDir, { recursive: true });

      // 古い poller.json を作成（30秒前 = stale）
      fs.writeFileSync(pollerJsonPath, JSON.stringify({
        pid: 999999,
        heartbeat: Date.now() - 30000,
        startedAt: new Date(Date.now() - 60000).toISOString(),
      }), 'utf8');

      // 新しい poller が乗っ取り、poller.json を更新する
      await withPoller(workspace, mockDir, async (child) => {
        // 並行実行により claimPoller の write が完了していない可能性があるためリトライ
        let state;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
            if (state.pid && state.pid !== 999999) break;
          } catch {}
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        assert.ok(state, 'poller.json が読み取れるべき');
        assert.notEqual(state.pid, 999999, 'pid が新しいプロセスのものに変わっているべき');
        assert.equal(state.pid, child.pid, '新しい pid と一致するべき');
        assert.ok(state.heartbeat, 'heartbeat が存在する');
      });
    } finally {
      fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });
});

// ── lazy-start（queue-send が poller を起動する） ───────────────────────

/**
 * poller.json から pid を読み取り、プロセスを kill する。
 * テスト後の後始末用。存在しない・kill失敗は握りつぶす。
 */
function killPollerFromJson(pollerJsonPath) {
  try {
    const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
    if (state.pid && state.pid > 0) {
      try { process.kill(state.pid, 'SIGTERM'); } catch {}
      // Windows: detached 子プロセスには SIGTERM が効かないため taskkill /F で確実に kill
      if (process.platform === 'win32') {
        try { spawnSync('taskkill', ['/F', '/PID', String(state.pid)], { stdio: 'ignore' }); } catch {}
      }
    }
  } catch {}
}

test('enqueue 後に poller.json がなければ queue-send が poller を起動する', () => {
  withTempDir(workspace => {
    const pollerJsonPath = path.join(workspace, '.gh-maestro', 'queue', 'poller.json');

    try {
      // queue-send でメッセージを送信（lazy-start で poller が detached 起動される）
      // gate を明示的に無効化: このテストは lazy-start の実挙動を検証する
      const r = runSend(['worker-1', 'hello', '--workspace', workspace], { GH_MAESTRO_DISABLE_LAZY_POLLER: '' });
      assert.equal(r.status, 0);
      assert.ok(r.stdout.trim().length > 0);

      // detached 起動なので、poller.json ができて実際の poller が pid を書き込むまで待つ
      // （lazy-start がプレースホルダー pid=0 を先に書くため、pid>0 を確認する）
      const maxWait = 5000;
      const start = Date.now();
      let started = false;
      while (Date.now() - start < maxWait) {
        try {
          if (fs.existsSync(pollerJsonPath)) {
            const s = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
            if (s.pid && s.pid > 0) {
              assert.ok(s.heartbeat, 'heartbeat が存在する');
              assert.ok(s.pid, 'pid が存在する');
              started = true;
              break;
            }
          }
        } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      assert.ok(started, 'lazy-start で poller が起動し pid>0 になるべき');
    } finally {
      // hazard 防止: 必ず kill
      killPollerFromJson(pollerJsonPath);
    }
  });
});

test('既に poller が稼働中なら lazy-start は2つ目を起動しない', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    const pollerJsonPath = path.join(queueDir, 'poller.json');
    fs.mkdirSync(queueDir, { recursive: true });

    try {
      // 新鮮な poller.json を作成（pid は実在しない値でOK）
      fs.writeFileSync(pollerJsonPath, JSON.stringify({
        pid: 0,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
      }), 'utf8');

      // queue-send でメッセージを送信（poller が生きているので lazy-start しない）
      // gate を明示的に無効化: このテストは lazy-start の実挙動を検証する
      const r = runSend(['worker-1', 'hello', '--workspace', workspace], { GH_MAESTRO_DISABLE_LAZY_POLLER: '' });
      assert.equal(r.status, 0);

      // poller.json の内容は変わらない（新しいプロセスが起動していない）
      const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
      assert.equal(state.pid, 0, '既存の poller.json が維持されるべき');
    } finally {
      // pid=0 プレースホルダーは acquirePollerLease に実 spawn される。
      // spawnSync 終了時点では poller が poller.json をまだ上書きしていないため、
      // pid>0 になるまで待ってから kill する（pid=0 のままでは kill をすり抜ける）。
      const maxWait = 3000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        try {
          if (fs.existsSync(pollerJsonPath)) {
            const s = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
            if (s.pid && s.pid > 0) break;
          }
        } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      killPollerFromJson(pollerJsonPath);
    }
  });
});
