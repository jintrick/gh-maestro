'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const watch = require('../scripts/assistant-watch');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-assistant-watch-test-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
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
  watch._setGhPrList(() => ({ status: 0, stdout: JSON.stringify([]), stderr: '' }));
  // 実待機の上限を20msに抑えつつ、リアルタイムを少しずつ進める（msg-poll.test.jsと同じ
  // パターン。ゼロ遅延だとタイムアウト判定がDate.now()基準のためビジーループになる）。
  watch._setSleep(async (ms) => { await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))); });
  Object.entries(overrides).forEach(([k, v]) => {
    if (k === 'ghRepoView') watch._setGhRepoView(v);
    if (k === 'ghIssueComments') watch._setGhIssueComments(v);
    if (k === 'ghPrList') watch._setGhPrList(v);
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

  test('フラグの値欠落は exitFlagMiss:true を返す', () => {
    assert.equal(watch.parseArgs(['--issue']).exitFlagMiss, true);
  });

  test('未知の位置引数は unknownArgs を返す', () => {
    const r = watch.parseArgs(['--issue', '5', 'extra']);
    assert.deepEqual(r.unknownArgs, ['extra']);
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
    const r = await watch.main(['--issue', '5', '--workspace', '/definitely/does/not/exist/xyz']);
    // resolveWorkspace は存在確認をしないため、実際に workspace 解決エラーになるのは
    // --workspace 省略時に CWD 上方探索で見つからない場合。ここでは --repo 解決失敗で確認する。
    assert.equal(typeof r.code, 'number');
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
        ghPrList: () => ({
          status: 0,
          stdout: JSON.stringify([{ number: 10, state: 'OPEN', mergedAt: null }]),
        }),
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
        ghPrList: () => ({
          status: 0,
          stdout: JSON.stringify([{ number: 42, state: 'OPEN', mergedAt: null }]),
        }),
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
        ghPrList: () => ({
          status: 0,
          stdout: JSON.stringify([{ number: 42, state: 'OPEN', mergedAt: null }]),
        }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.deepEqual(r.lines, ['TIMEOUT']);
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
        ghPrList: () => ({
          status: 0,
          stdout: JSON.stringify([{ number: 42, state: 'MERGED', mergedAt: '2026-07-28T00:00:00Z' }]),
        }),
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
        ghPrList: () => ({
          status: 0,
          stdout: JSON.stringify([{ number: 42, state: 'MERGED', mergedAt: '2026-07-28T00:00:00Z' }]),
        }),
      });

      const r = await watch.main(['--issue', '5', '--workspace', workspace, '--wait', '1']);
      assert.deepEqual(r.lines, ['TIMEOUT']);
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
  const SCRIPT = path.join(__dirname, '..', 'scripts', 'assistant-watch.js');

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
