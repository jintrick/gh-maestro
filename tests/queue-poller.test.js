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
 *
 * @param {string}   workspace
 * @param {string}   tmpDir        mock ファイルを置く一時ディレクトリ
 * @param {Function} fn            (child, pollerJsonPath, stderr) => Promise<void>
 * @param {object}   [opts]
 * @param {string}   [opts.mockBody]   カスタム mock スクリプト本体（既定: 常に exit 0）
 * @param {object}   [opts.extraEnv]   追加の環境変数
 * @param {number}   [opts.timeoutMs]  タイムアウト（既定: 10000）
 * @param {boolean}  [opts.expectExit] true なら poller の exit をエラー扱いしない
 */
function withPoller(workspace, tmpDir, fn, opts = {}) {
  const {
    mockBody,
    extraEnv = {},
    timeoutMs = 10000,
    expectExit = false,
  } = opts;

  return new Promise((resolve, reject) => {
    const mockPath = path.join(tmpDir, 'wezterm-mock.js');
    fs.writeFileSync(
      mockPath,
      mockBody || (
        "const a = process.argv.slice(2).join(' ');\n" +
        "if (a.startsWith('cli list')) process.stdout.write('[]');\n" +
        "process.exit(0);\n"
      ),
      'utf8'
    );

    const child = spawn(process.execPath, [POLLER_SCRIPT, '--workspace', workspace], {
      env: { ...process.env, WEZTERM_MOCK: mockPath, GH_MAESTRO_DISABLE_LAZY_POLLER: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`Poller timeout (${timeoutMs}ms)\nstderr: ${stderr}`));
    }, timeoutMs);

    if (!expectExit) {
      child.on('exit', () => {
        clearTimeout(timeout);
        reject(new Error(`Poller unexpectedly exited\nstderr: ${stderr}`));
      });
    }

    // poller.json ができるまで待つ
    const pollerJsonPath = path.join(workspace, '.gh-maestro', 'queue', 'poller.json');
    const waitStart = Date.now();
    (function waitPoller() {
      if (fs.existsSync(pollerJsonPath)) {
        // 少し待ってからコールバック（初期化完了を保証）
        setTimeout(async () => {
          try {
            await fn(child, pollerJsonPath, stderr);
            try { child.kill(); } catch {}
            clearTimeout(timeout);
            resolve();
          } catch (e) {
            try { child.kill(); } catch {}
            clearTimeout(timeout);
            reject(e);
          }
        }, 300);
        return;
      }
      if (Date.now() - waitStart > 5000) {
        try { child.kill(); } catch {}
        clearTimeout(timeout);
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
    if (process.platform === 'win32' && child.pid) {
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
      // 生きている poller をエミュレート: テストプロセス自身の pid で poller.json を作成
      fs.writeFileSync(pollerJsonPath, JSON.stringify({
        pid: process.pid,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
      }), 'utf8');

      // queue-send でメッセージを送信（poller が生きているので lazy-start しない）
      // gate を明示的に無効化: このテストは lazy-start の実挙動を検証する
      const r = runSend(['worker-1', 'hello', '--workspace', workspace], { GH_MAESTRO_DISABLE_LAZY_POLLER: '' });
      assert.equal(r.status, 0);

      // poller.json の pid はそのまま（2つ目を起動していない）
      const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
      assert.equal(state.pid, process.pid, '既存の poller.json が維持されるべき');
    } finally {
      // 実 spawn は一切発生しない（acquirePollerLease が稼働中 poller と正しく判断する）
      // 後始末不要。万一の lease 上書きに備え poller.json があれば削除しておく。
      try { fs.unlinkSync(pollerJsonPath); } catch {}
    }
  });
});

// ── muxId lease 判定（ユニットテスト: 実 spawn なし） ───────────────────

test('acquirePollerLease: muxId 不一致 かつ muxReachable:false なら fresh heartbeat でも乗っ取る', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    const pollerJsonPath = path.join(queueDir, 'poller.json');
    fs.mkdirSync(queueDir, { recursive: true });

    // 旧 mux の degraded poller を模擬: 新鮮な heartbeat + 異なる muxId + self-declared degraded
    fs.writeFileSync(pollerJsonPath, JSON.stringify({
      pid: 999999,
      heartbeat: Date.now(),
      startedAt: new Date().toISOString(),
      muxId: '/old/wezterm/socket/path',
      muxReachable: false,
    }), 'utf8');

    const originalMuxId = process.env.WEZTERM_UNIX_SOCKET;
    process.env.WEZTERM_UNIX_SOCKET = '/new/wezterm/socket/path';
    try {
      const payload = JSON.stringify({
        pid: process.pid,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
        muxId: getMuxId(),
        muxReachable: true,
      });
      const result = acquirePollerLease(workspace, payload);
      assert.ok(result, 'degraded + muxId 不一致なら乗っ取るべき');

      const updated = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
      assert.equal(updated.pid, process.pid, 'pid が現在のプロセスに上書きされているべき');
      assert.equal(updated.muxId, '/new/wezterm/socket/path', 'muxId が新しい値に上書きされているべき');
    } finally {
      if (originalMuxId === undefined) {
        delete process.env.WEZTERM_UNIX_SOCKET;
      } else {
        process.env.WEZTERM_UNIX_SOCKET = originalMuxId;
      }
    }
  });
});

test('acquirePollerLease: muxId 不一致でも muxReachable:true なら乗っ取らない（クロスターミナル DoS 防止）', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    const pollerJsonPath = path.join(queueDir, 'poller.json');
    fs.mkdirSync(queueDir, { recursive: true });

    // 健全 poller（異なる mux だが muxReachable:true）
    fs.writeFileSync(pollerJsonPath, JSON.stringify({
      pid: 999999,
      heartbeat: Date.now(),
      startedAt: new Date().toISOString(),
      muxId: '/other/wezterm/socket',
      muxReachable: true,
    }), 'utf8');

    const originalMuxId = process.env.WEZTERM_UNIX_SOCKET;
    process.env.WEZTERM_UNIX_SOCKET = '/my/wezterm/socket';
    try {
      const payload = JSON.stringify({
        pid: process.pid,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
        muxId: getMuxId(),
        muxReachable: true,
      });
      const result = acquirePollerLease(workspace, payload);
      assert.ok(!result, '健全 poller は muxId 不一致だけでは乗っ取らない（DoS 防止）');

      const existing = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
      assert.equal(existing.pid, 999999, 'pid が維持されているべき');
    } finally {
      if (originalMuxId === undefined) {
        delete process.env.WEZTERM_UNIX_SOCKET;
      } else {
        process.env.WEZTERM_UNIX_SOCKET = originalMuxId;
      }
    }
  });
});

test('acquirePollerLease: muxId が同じなら fresh heartbeat では退出する', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    const pollerJsonPath = path.join(queueDir, 'poller.json');
    fs.mkdirSync(queueDir, { recursive: true });

    // 同じ mux の poller を模擬
    const originalMuxId = process.env.WEZTERM_UNIX_SOCKET;
    process.env.WEZTERM_UNIX_SOCKET = '/same/wezterm/socket';
    try {
      fs.writeFileSync(pollerJsonPath, JSON.stringify({
        pid: 999999,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
        muxId: '/same/wezterm/socket',
      }), 'utf8');

      const payload = JSON.stringify({
        pid: process.pid,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
        muxId: getMuxId(),
      });
      const result = acquirePollerLease(workspace, payload);
      assert.ok(!result, '同じ muxId で新鮮なら退出すべき');

      // poller.json は上書きされない
      const existing = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
      assert.equal(existing.pid, 999999, 'pid が維持されているべき');
    } finally {
      if (originalMuxId === undefined) {
        delete process.env.WEZTERM_UNIX_SOCKET;
      } else {
        process.env.WEZTERM_UNIX_SOCKET = originalMuxId;
      }
    }
  });
});

test('acquirePollerLease: 既存 lease に muxId がない場合は後方互換（heartbeat のみで判定）', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    const pollerJsonPath = path.join(queueDir, 'poller.json');
    fs.mkdirSync(queueDir, { recursive: true });

    // muxId なしの poller.json（旧バージョンからの移行）
    fs.writeFileSync(pollerJsonPath, JSON.stringify({
      pid: 999999,
      heartbeat: Date.now(),
      startedAt: new Date().toISOString(),
    }), 'utf8');

    const originalMuxId = process.env.WEZTERM_UNIX_SOCKET;
    process.env.WEZTERM_UNIX_SOCKET = '/some/mux';
    try {
      const payload = JSON.stringify({
        pid: process.pid,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
        muxId: getMuxId(),
      });
      const result = acquirePollerLease(workspace, payload);
      // 既存に muxId なし → muxId 比較スキップ → heartbeat のみで判定 → fresh なので退出
      assert.ok(!result, '後方互換: muxId なしの既存 lease は heartbeat のみで判定');
    } finally {
      if (originalMuxId === undefined) {
        delete process.env.WEZTERM_UNIX_SOCKET;
      } else {
        process.env.WEZTERM_UNIX_SOCKET = originalMuxId;
      }
    }
  });
});

test('acquirePollerLease: 現在の muxId が取得不能でも後方互換（heartbeat のみで判定）', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    const pollerJsonPath = path.join(queueDir, 'poller.json');
    fs.mkdirSync(queueDir, { recursive: true });

    // muxId ありの既存 poller
    fs.writeFileSync(pollerJsonPath, JSON.stringify({
      pid: 999999,
      heartbeat: Date.now(),
      startedAt: new Date().toISOString(),
      muxId: '/some/mux',
    }), 'utf8');

    // WEZTERM_UNIX_SOCKET 未設定
    const originalMuxId = process.env.WEZTERM_UNIX_SOCKET;
    delete process.env.WEZTERM_UNIX_SOCKET;
    try {
      const payload = JSON.stringify({
        pid: process.pid,
        heartbeat: Date.now(),
        startedAt: new Date().toISOString(),
        muxId: null,
      });
      const result = acquirePollerLease(workspace, payload);
      // 現在の muxId なし → muxId 比較スキップ → heartbeat のみで判定 → fresh なので退出
      assert.ok(!result, '後方互換: 現在の muxId なしなら heartbeat のみで判定');
    } finally {
      if (originalMuxId === undefined) {
        delete process.env.WEZTERM_UNIX_SOCKET;
      } else {
        process.env.WEZTERM_UNIX_SOCKET = originalMuxId;
      }
    }
  });
});

test('getMuxId: WEZTERM_UNIX_SOCKET が設定されていればその値を返す', () => {
  const original = process.env.WEZTERM_UNIX_SOCKET;
  process.env.WEZTERM_UNIX_SOCKET = '/test/socket/path';
  try {
    assert.equal(getMuxId(), '/test/socket/path');
  } finally {
    if (original === undefined) {
      delete process.env.WEZTERM_UNIX_SOCKET;
    } else {
      process.env.WEZTERM_UNIX_SOCKET = original;
    }
  }
});

test('getMuxId: WEZTERM_UNIX_SOCKET が未設定なら null を返す', () => {
  const original = process.env.WEZTERM_UNIX_SOCKET;
  delete process.env.WEZTERM_UNIX_SOCKET;
  try {
    assert.equal(getMuxId(), null);
  } finally {
    if (original !== undefined) {
      process.env.WEZTERM_UNIX_SOCKET = original;
    }
  }
});

// ── mux 到達性自己検証（withPoller + モック wezterm） ──────────────────

function healthyMockBody() {
  return (
    "const a = process.argv.slice(2).join(' ');\n" +
    "if (a.startsWith('cli list --format json')) process.stdout.write('[]');\n" +
    "process.exit(0);\n"
  );
}

function failingMockBody() {
  return (
    "const a = process.argv.slice(2).join(' ');\n" +
    "if (a.startsWith('cli list --format json')) {\n" +
    "  process.stderr.write('mux unreachable (mock)\\n');\n" +
    "  process.exit(1);\n" +
    "}\n" +
    "process.exit(0);\n"
  );
}

test('poller: mux 到達性が健全なら poller は生存し続け muxReachable:true が維持される', async () => {
  await withTempDir(async workspace => {
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-mock-'));
    try {
      await withPoller(workspace, mockDir, async (child, pollerJsonPath, stderr) => {
        const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
        assert.ok(state.pid > 0, 'poller が生存しているべき');
        // 健全な mux では失敗ログが出ない
        assert.ok(!stderr.includes('mux reachability check failed'), '健全な mux では失敗ログが出ない');
        // muxReachable は起動時の true が維持される
        assert.equal(state.muxReachable, true, 'muxReachable が true であるべき');
      }, {
        mockBody: healthyMockBody(),
        extraEnv: { WEZTERM_UNIX_SOCKET: '/test/mux/socket' },
      });
    } finally {
      fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });
});

test('poller: mux 到達性の連続失敗で degraded モードに遷移し生存継続する（自主 exit しない）', async () => {
  await withTempDir(async workspace => {
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-mock-'));
    try {
      // degraded モード遷移を検証するため、poller.json ができた後も poller を生かしたまま
      // 十分な時間（> MAX_MUX_CHECK_FAILURES × POLL_INTERVAL_MS）待機する
      await new Promise((resolve, reject) => {
        const mockPath = path.join(mockDir, 'wezterm-mock.js');
        fs.writeFileSync(mockPath, failingMockBody(), 'utf8');

        const child = spawn(process.execPath, [POLLER_SCRIPT, '--workspace', workspace], {
          env: {
            ...process.env,
            WEZTERM_MOCK: mockPath,
            GH_MAESTRO_DISABLE_LAZY_POLLER: '1',
            WEZTERM_UNIX_SOCKET: '/test/mux/socket',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });

        const pollerJsonPath = path.join(workspace, '.gh-maestro', 'queue', 'poller.json');

        // poller.json ができるまで待ってから、さらに degraded 遷移まで待つ
        const maxWait = 30000; // 3 failures × 5s = 15s + 余裕
        const pollInterval = 500;
        let elapsed = 0;
        let degradedSeen = false;

        const check = setInterval(() => {
          elapsed += pollInterval;
          try {
            if (fs.existsSync(pollerJsonPath)) {
              const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
              if (state.muxReachable === false) {
                degradedSeen = true;
                assert.ok(state.pid > 0, 'degraded でも poller は生存しているべき');
                assert.ok(stderr.includes('mux reachability check failed'), '失敗ログが出ているべき');
                assert.ok(stderr.includes('entering degraded mode'), 'degraded モード遷移ログが出ているべき');
                assert.ok(!stderr.includes('releasing lease and exiting'), '自主 exit ログは出ないべき');
                clearInterval(check);
                try { child.kill(); } catch {}
                resolve();
              }
            }
          } catch {}
          if (elapsed >= maxWait) {
            clearInterval(check);
            try { child.kill(); } catch {}
            if (degradedSeen) {
              resolve();
            } else {
              reject(new Error(`degraded mode not entered within ${maxWait}ms\nstderr: ${stderr}`));
            }
          }
        }, pollInterval);

        child.on('exit', () => {
          clearInterval(check);
          reject(new Error(`Poller should not exit in degraded mode\nstderr: ${stderr}`));
        });
      });
    } finally {
      fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });
});

test('poller: getMuxId が null の環境では mux-check をスキップし degraded にならない', async () => {
  await withTempDir(async workspace => {
    const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-mock-'));
    try {
      await new Promise((resolve, reject) => {
        const mockPath = path.join(mockDir, 'wezterm-mock.js');
        fs.writeFileSync(mockPath, failingMockBody(), 'utf8');

        const env = { ...process.env, WEZTERM_MOCK: mockPath, GH_MAESTRO_DISABLE_LAZY_POLLER: '1' };
        delete env.WEZTERM_UNIX_SOCKET;

        const child = spawn(process.execPath, [POLLER_SCRIPT, '--workspace', workspace], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });

        const pollerJsonPath = path.join(workspace, '.gh-maestro', 'queue', 'poller.json');

        // 8秒待機（> 3 failures × 5s 相当）して degraded になっていないことを確認
        setTimeout(() => {
          try {
            assert.ok(fs.existsSync(pollerJsonPath), 'poller.json が存在するべき（生存）');
            const state = JSON.parse(fs.readFileSync(pollerJsonPath, 'utf8'));
            assert.ok(state.pid > 0, 'poller が生存しているべき');
            assert.ok(!stderr.includes('mux reachability check failed'),
              `getMuxId null では mux-check が走らない。stderr: ${stderr}`);
            assert.ok(!stderr.includes('entering degraded mode'),
              `degraded ログが出ていないべき。stderr: ${stderr}`);
          } catch (e) {
            try { child.kill(); } catch {}
            reject(e);
            return;
          }
          try { child.kill(); } catch {}
          resolve();
        }, 8000);

        child.on('exit', () => {});

        setTimeout(() => {
          try { child.kill(); } catch {}
          reject(new Error(`Null-muxId poller should not exit\nstderr: ${stderr}`));
        }, 15000);
      });
    } finally {
      fs.rmSync(mockDir, { recursive: true, force: true });
    }
  });
});

// ── poller-state 永続化（ユニットテスト: 実 spawn なし） ────────────────

const { pollerStatePath, writeLastNotifiedState, readLastNotifiedState, acquirePollerLease, getMuxId } = require('../scripts/queue-poller');

test('writeLastNotifiedState + readLastNotifiedState のラウンドトリップ', () => {
  withTempDir(workspace => {
    const statePath = pollerStatePath(workspace);
    assert.ok(statePath.endsWith('poller-state.json'));

    // 書き込み
    const map = new Map();
    map.set('msg-1', 1700000000000);
    map.set('msg-2', 1700000001000);
    writeLastNotifiedState(workspace, map);

    // 読み取り
    const state = readLastNotifiedState(workspace);
    assert.ok(state, 'state が読み取れるべき');
    assert.ok(state.lastNotifiedAt, 'lastNotifiedAt が存在するべき');
    assert.equal(state.lastNotifiedAt['msg-1'], 1700000000000);
    assert.equal(state.lastNotifiedAt['msg-2'], 1700000001000);
  });
});

test('readLastNotifiedState が poller-state.json 不在時に null を返す', () => {
  withTempDir(workspace => {
    const state = readLastNotifiedState(workspace);
    assert.equal(state, null);
  });
});

test('readLastNotifiedState が壊れた JSON で null を返す', () => {
  withTempDir(workspace => {
    const queueDir = path.join(workspace, '.gh-maestro', 'queue');
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(path.join(queueDir, 'poller-state.json'), 'not json', 'utf8');

    const state = readLastNotifiedState(workspace);
    assert.equal(state, null);
  });
});

test('writeLastNotifiedState が空 Map を書き込める', () => {
  withTempDir(workspace => {
    writeLastNotifiedState(workspace, new Map());

    const state = readLastNotifiedState(workspace);
    assert.ok(state, 'state が読み取れるべき');
    assert.deepEqual(state.lastNotifiedAt, {});
  });
});
