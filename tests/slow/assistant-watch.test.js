'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const watch = require('../../scripts/assistant-watch');
const { spawnSync } = require('../../scripts/shared/child-process');
const { reviewArtifactPath } = require('../../scripts/shared/review-manager-paths');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-assistant-watch-test-'));
  // workspace引数を省略する経路も一時ディレクトリへ隔離できるよう、
  // GH_MAESTRO_WORKSPACE のフォールバックをテスト用ディレクトリにする。
  const origWorkspace = process.env.GH_MAESTRO_WORKSPACE;
  process.env.GH_MAESTRO_WORKSPACE = dir;
  const cleanup = () => {
    if (origWorkspace !== undefined) process.env.GH_MAESTRO_WORKSPACE = origWorkspace;
    else delete process.env.GH_MAESTRO_WORKSPACE;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let result;
  try {
    result = fn(dir);
  } catch (e) {
    cleanup();
    throw e;
  }
  if (result && typeof result.then === 'function') {
    return result.finally(cleanup);
  }
  cleanup();
  return result;
}

function stubOk(overrides = {}) {
  watch._setGhRepoView(() => ({ status: 0, stdout: 'owner/repo\n', stderr: '' }));
  watch._setGhIssueComments(() => ({ status: 0, stdout: JSON.stringify([]), stderr: '' }));
  watch._setGhFindPr(() => []);
  watch._setGhPrView(() => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }), stderr: '' }));
  // テスト用時計を進めるだけにし、実時間のtimeout待機を発生させない。
  let now = 0;
  watch._setNow(() => now);
  // 500msずつ進めることで、3秒の論理待機内に閾値(5回)だけを通過させる。
  watch._setSleep(async () => { now += 500; });
  watch._setWriteState(watch.writeState);
  Object.entries(overrides).forEach(([k, v]) => {
    if (k === 'ghRepoView') watch._setGhRepoView(v);
    if (k === 'ghIssueComments') watch._setGhIssueComments(v);
    if (k === 'ghFindPr') watch._setGhFindPr(v);
    if (k === 'ghPrView') watch._setGhPrView(v);
  });
}

function commentEntry({ id, from, to = 'orchestrator', body }) {
  const marker = JSON.stringify({ v: 1, to, from });
  return { id, body: body ?? `<!-- gh-maestro ${marker} -->\n> ${from}からの報告です` };
}

// ── parseArgs ────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('--help は help:true を返す', () => {
    assert.equal(watch.parseArgs(['--help']).help, true);
  });

  test('フラグの値欠落は validationErrors を返す', () => {
    const r = watch.parseArgs(['--issue']);
    assert.equal(r.help, false);
    assert.ok(r.validationErrors.some(e => e.message === 'フラグ --issue には値が必要です'));
  });

  test('未知の位置引数は validationErrors を返す', () => {
    const r = watch.parseArgs(['--issue', '5', 'extra']);
    assert.equal(r.help, false);
    assert.ok(r.validationErrors.some(e => e.message === '予期しない位置引数です: extra'));
  });

  test('正常系: 各フラグを分離する', () => {
    const r = watch.parseArgs(['--issue', '5', '--workspace', '/ws', '--repo', 'a/b', '--wait', '30', '--interval', '5']);
    assert.equal(r.issueArg, '5');
    assert.equal(r.workspaceArg, '/ws');
    assert.equal(r.repoArg, 'a/b');
    assert.equal(r.waitArg, '30');
    assert.equal(r.intervalArg, '5');
  });
});

// ── main(): 引数検証 ─────────────────────────────────────────────────────

describe('main: 引数検証', () => {
  test('--issue が無ければエラー', async () => {
    const r = await watch.main(['--workspace', '/ws']);
    assert.equal(r.code, 1);
  });

  test('--issue が正の整数でなければエラー', async () => {
    const r = await watch.main(['--issue', '0', '--workspace', '/ws']);
    assert.equal(r.code, 1);
  });

  test('workspace を解決できなければエラー', async () => {
    // 明示した --workspace が使われることを確認するため、git repoではない
    // テンポラリディレクトリを渡し、_ghRepoView が失敗するパスを検証する。
    await withTempDir(async (workspace) => {
      const r = await watch.main(['--issue', '5', '--workspace', workspace]);
      assert.equal(typeof r.code, 'number');
    });
  });

  test('リポジトリを解決できなければエラー', async () => {
    await withTempDir(async (workspace) => {
      watch._setGhRepoView(() => ({ status: 1, stdout: '', stderr: 'not a git repository' }));
      const r = await watch.main(['--issue', '5', '--workspace', workspace]);
      assert.equal(r.code, 1);
      assert.ok(r.errLines.some((l) => l.includes('リポジトリ')));
    });
  });
});

// ── main(): 初回実行はベースライン確立のみ（イベント化しない） ────────────

describe('main: 初回実行のベースライン確立', () => {
  test('既存のコメント・PRがあってもイベント化せず、TIMEOUTで終了する', async () => {
    await withTempDir(async (workspace) => {
      stubOk({
        ghIssueComments: () => ({
          status: 0,
          stdout: JSON.stringify([commentEntry({ id: 1, from: 'issue-5-fix' })]),
        }),
        ghFindPr: () => [10],
        ghPrView: () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }) }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.equal(r.code, 0);
      assert.deepEqual(r.lines, ['TIMEOUT']);

      const state = watch.readState(workspace, '5');
      assert.equal(state.lastCommentId, 1);
      assert.equal(state.prs['10'].merged, false);
    });
  });
});

// ── main(): イベント検知（既存stateがある状態からの差分） ──────────────────

describe('main: worker_report検知', () => {
  test('orchestrator宛のワーカー報告（新規コメント）を検知する', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', { lastCommentId: 1, prs: {} });
      stubOk({
        ghIssueComments: () => ({
          status: 0,
          stdout: JSON.stringify([
            commentEntry({ id: 1, from: 'issue-5-fix' }), // 既知（無視される）
            commentEntry({ id: 2, from: 'issue-5-fix', body: '<!-- gh-maestro {"v":1,"to":"orchestrator","from":"issue-5-fix"} -->\n> 実装が完了しPR #42を作成しました' }),
          ]),
        }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '5']);
      assert.equal(r.code, 0);
      assert.equal(r.lines.length, 1);
      const event = JSON.parse(r.lines[0].replace(/^EVENT /, ''));
      assert.equal(event.type, 'worker_report');
      assert.equal(event.commentId, 2);
      assert.equal(event.from, 'issue-5-fix');
      assert.ok(event.preview.includes('PR #42'));
    });
  });

  test('orchestrator発の投稿（from:orchestrator）はworker_reportとして検知しない', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', { lastCommentId: 0, prs: {} });
      stubOk({
        ghIssueComments: () => ({
          status: 0,
          stdout: JSON.stringify([
            commentEntry({ id: 1, from: 'orchestrator', to: 'issue-5-fix' }),
          ]),
        }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.deepEqual(r.lines, ['TIMEOUT']);
    });
  });

  test('マーカーの無い雑多なコメントは無視されるが、カーソルは進む', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', { lastCommentId: 0, prs: {} });
      stubOk({
        ghIssueComments: () => ({
          status: 0,
          stdout: JSON.stringify([{ id: 1, body: 'ただの雑談コメント' }]),
        }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.deepEqual(r.lines, ['TIMEOUT']);
      assert.equal(watch.readState(workspace, '5').lastCommentId, 1);
    });
  });
});

// ── Issue #250: writeState の EPERM 失敗への耐性 ────────────────────────────
// writeState の失敗を注入し、OS依存のatomic-writeリトライ待機をテストへ持ち込まない。

describe('main: writeState失敗耐性', () => {
  test('writeState が失敗してもプロセスはクラッシュせず TIMEOUT で終了する', async () => {
    await withTempDir(async (workspace) => {
      watch._setNotifyOrchestrator(() => ({ status: 0, stdout: '', stderr: '' }));
      stubOk();
      watch._setWriteState(() => { throw new Error('injected write failure'); });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.equal(r.code, 0);
      assert.ok(r.lines.includes('TIMEOUT'), `Lines: ${r.lines.join('\n')}`);
      assert.ok(r.errLines.some(l => l.includes('状態の保存に失敗')), `errLines: ${r.errLines.join('\n')}`);
    });
  });

  test('writeState が失敗しても検出済みイベントは握り潰さず出力する', async () => {
    await withTempDir(async (workspace) => {
      watch._setNotifyOrchestrator(() => ({ status: 0, stdout: '', stderr: '' }));
      let ghCalls = 0;
      stubOk({
        ghIssueComments: () => {
          ghCalls++;
          // 1サイクル目（ベースライン）は空、2サイクル目からワーカー報告を返す。
          // ベースライン（writeState失敗で未永続化）でも state.lastCommentId はメモリ上で
          // 進むため、既存コメントを返すだけでは再検出されない。新規コメントを後から
          // 出現させることで非ベースラインサイクルのイベント検出を再現する。
          return {
            status: 0,
            stdout: JSON.stringify(
              ghCalls === 1 ? [] : [commentEntry({ id: 100, from: 'issue-5-fix' })]
            ),
            stderr: '',
          };
        },
      });
      watch._setWriteState(() => { throw new Error('injected write failure'); });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '5']);
      assert.equal(r.code, 0);
      // イベントは writeState 失敗でも握り潰されず出力される（重複側に倒れる）
      assert.ok(r.lines.some(l => l.startsWith('EVENT ')), `Lines: ${r.lines.join('\n')}`);
      assert.ok(r.errLines.some(l => l.includes('状態の保存に失敗')), `errLines: ${r.errLines.join('\n')}`);
    });
  });

  // ── PR #251: _notifyOrchestrator が実 msg-send.js コマンドを正しく構築する ──
  // 非ワーカーコンテキストの msg-send.js は宛先を位置引数（recipient）で受け取る。
  // 省略すると recipient が undefined になり usage エラーで必ず送信失敗するため、
  // 「呼ばれたこと」だけでなく「構築されるコマンドライン引数」を検証する。

  test('_notifyOrchestrator が msg-send.js に宛先(orchestrator)を含む実引数を渡す（連続失敗警告）', async () => {
    await withTempDir(async (workspace) => {
      stubOk();
      // 先行テスト（writeState失敗耐性）が _setNotifyOrchestrator を丸ごと差し替えたまま
      // 残すと、実関数経由の引数検証が素通しするため、実装を復元してから spawn だけを
      // 記録モックに差し替える。
      watch._setNotifyOrchestrator(watch._notifyOrchestrator);
      const spawnCalls = [];
      watch._setNotifySpawn((cmd, args, opts) => {
        spawnCalls.push({ cmd, args, opts });
        return { status: 0, stdout: '', stderr: '' };
      });
      // 連続失敗の警告契約だけを検証し、atomic-writeのOS依存リトライは実行しない。
      watch._setWriteState(() => { throw new Error('injected write failure'); });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '3']);
      assert.equal(r.code, 0);
      assert.equal(spawnCalls.length, 1, `警告の msg-send.js spawn が1回: ${JSON.stringify(spawnCalls)}`);
      const { cmd, args, opts } = spawnCalls[0];
      assert.equal(cmd, process.execPath);
      assert.ok(args[0].endsWith('msg-send.js'), `args[0]=msg-send.js であること: ${args.join(' ')}`);
      assert.equal(args[1], 'orchestrator', `recipient が位置引数で渡されること: ${args.join(' ')}`);
      assert.equal(args[args.indexOf('--from') + 1], 'assistant-watch');
      assert.equal(args[args.indexOf('--issue') + 1], '5');
      assert.equal(args[args.indexOf('--workspace') + 1], workspace);
      assert.ok(opts.input.includes('連続で失敗しています'), `stdin 本文に警告が含まれること`);
      // 先行テストが残していた状態（高レベルで実spawnしないモック）に戻す
      watch._setNotifyOrchestrator(() => ({ status: 0, stdout: '', stderr: '' }));
      watch._setNotifySpawn(spawnSync);
    });
  });
});

describe('main: hanseikai検知', () => {
  test('【反省会】で始まる新着コメントを検知する', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', { lastCommentId: 0, prs: {} });
      stubOk({
        ghIssueComments: () => ({
          status: 0,
          stdout: JSON.stringify([
            { id: 1, body: '【反省会】 Issue #5 / PR #42\n本文...' },
          ]),
        }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '5']);
      const event = JSON.parse(r.lines[0].replace(/^EVENT /, ''));
      assert.equal(event.type, 'hanseikai');
      assert.equal(event.commentId, 1);
    });
  });
});

describe('main: review_done検知', () => {
  test('.runningロックが既知(true)から消失するとreview_doneを1回だけ検知する', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', {
        lastCommentId: 0,
        prs: { 42: { merged: false, reviewSeenRunning: true, reviewReported: false } },
      });
      stubOk({
        ghPrView: () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }) }),
      });
      // ロックファイルは存在しない（= 完了）。

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '5']);
      assert.equal(r.lines.length, 1);
      const event = JSON.parse(r.lines[0].replace(/^EVENT /, ''));
      assert.equal(event.type, 'review_done');
      assert.equal(event.pr, 42);

      const state = watch.readState(workspace, '5');
      assert.equal(state.prs['42'].reviewReported, true);
    });
  });

  test('.runningロックが最初から無い（reviewSeenRunning:false）場合はreview_doneを誤検知しない', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', {
        lastCommentId: 0,
        prs: { 42: { merged: false, reviewSeenRunning: false, reviewReported: false } },
      });
      stubOk({
        ghPrView: () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }) }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.deepEqual(r.lines, ['TIMEOUT']);
    });
  });

  test('新しいレビュー周回（close→reopen等）が始まるとreviewReportedがリセットされ、2回目の完了も検知できる', async () => {
    await withTempDir(async (workspace) => {
      const ghDir = path.join(workspace, '.gh-maestro');
      const lockPath = reviewArtifactPath(workspace, 42, '.running');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });

      const state = { lastCommentId: 0, prs: { 42: { merged: false, reviewSeenRunning: true, reviewReported: true } } };
      stubOk({ ghPrView: () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }) }) });

      // 2周目のレビューが開始（ロック再作成）。1周目の reviewReported:true を引きずらず
      // リセットされることを確認する（リセットが無いと2回目の review_done が永久に発火しない）。
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid,
        startTime: '2026-07-28T00:00:00.000Z',
      }));
      const scanOpts = {
        workspace, ghDir, repo: 'owner/repo', issue: '5', state, isBaseline: false, ghOpts: {},
        isProcessAliveFn: () => true,
        verifyProcessIdentityFn: () => ({ match: true }),
      };
      let r = watch.scanOnce(scanOpts);
      assert.equal(r.events.length, 0);
      assert.equal(state.prs['42'].reviewReported, false);
      assert.equal(state.prs['42'].reviewSeenRunning, true);

      // 2周目のレビューが完了（ロック消失）。
      fs.unlinkSync(lockPath);
      r = watch.scanOnce(scanOpts);
      assert.equal(r.events.length, 1);
      assert.equal(r.events[0].type, 'review_done');
      assert.equal(r.events[0].pr, 42);
      assert.equal(state.prs['42'].reviewReported, true);
    });
  });
});

describe('main: pr_merged検知', () => {
  test('既知PRがマージ済みへ遷移するとpr_mergedを検知する', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', {
        lastCommentId: 0,
        prs: { 42: { merged: false, reviewSeenRunning: false, reviewReported: false } },
      });
      stubOk({
        ghPrView: () => ({ status: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-28T00:00:00Z' }) }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '5']);
      const event = JSON.parse(r.lines[0].replace(/^EVENT /, ''));
      assert.equal(event.type, 'pr_merged');
      assert.equal(event.pr, 42);
      assert.equal(event.mergedAt, '2026-07-28T00:00:00Z');
    });
  });

  test('既にmerged済みのPRは再度イベント化しない', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', {
        lastCommentId: 0,
        prs: { 42: { merged: true, reviewSeenRunning: false, reviewReported: true } },
      });
      stubOk({
        ghPrView: () => ({ status: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-28T00:00:00Z' }) }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.deepEqual(r.lines, ['TIMEOUT']);
    });
  });
});

// ── _ghFindPr: poll-pr.js findPR() と同じ2段構え ────────────────────────

describe('main: PR新規発見のクエリ精度', () => {
  test('_ghFindPrが返したPR番号を新規発見として扱い、初回発見時にpr_createdイベントを発行する', async () => {
    await withTempDir(async (workspace) => {
      // 既存stateがある状態（初回ベースライン確立済み）で新規PRを発見 → pr_createdが発行される
      watch.writeState(workspace, '5', {
        lastCommentId: 0,
        prs: { 42: { merged: false, reviewSeenRunning: false, reviewReported: false } },
      });
      stubOk({
        ghFindPr: () => [99],
        ghPrView: () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }) }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '5']);
      assert.equal(r.lines.length, 1);
      const event = JSON.parse(r.lines[0].replace(/^EVENT /, ''));
      assert.equal(event.type, 'pr_created');
      assert.equal(event.pr, 99);
      const state = watch.readState(workspace, '5');
      assert.ok(state.prs['99']);
      assert.equal(state.prs['99'].merged, false);
    });
  });
});

// ── gh呼び出し失敗時のふるまい ───────────────────────────────────────────

describe('main: gh呼び出し失敗', () => {
  test('コメント取得が失敗してもPR一覧チェックは継続し、エラーを記録してタイムアウトする', async () => {
    await withTempDir(async (workspace) => {
      watch.writeState(workspace, '5', { lastCommentId: 0, prs: {} });
      stubOk({
        ghIssueComments: () => ({ status: 1, stdout: '', stderr: 'rate limit' }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.equal(r.code, 0);
      assert.deepEqual(r.lines, ['TIMEOUT']);
      assert.ok(r.errLines.some((l) => l.includes('コメント取得')));
    });
  });
});

// ── extractPreview ───────────────────────────────────────────────────────

describe('extractPreview', () => {
  test('マーカー行を除去し、長すぎる場合は切り詰める', () => {
    const body = '<!-- gh-maestro {"v":1} -->\n> 本文がここに入ります';
    assert.equal(watch.extractPreview(body), '> 本文がここに入ります');
  });

  test('maxLenを超える場合は末尾に … を付けて切り詰める', () => {
    const body = 'x'.repeat(400);
    const preview = watch.extractPreview(body, 300);
    assert.equal(preview.length, 301);
    assert.ok(preview.endsWith('…'));
  });
});

// ── CLI: --help / 引数不足 ───────────────────────────────────────────────

describe('CLI', () => {
  const { spawnSync } = require('child_process');
  const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'assistant-watch.js');

  test('--help はUsageを表示して終了コード0', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /assistant-watch\.js/);
  });

  test('引数不足はUsageをstderrに出して終了コード1', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--issue/);
  });
});
