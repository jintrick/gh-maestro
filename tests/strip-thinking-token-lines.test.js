'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { compactWorkerLog, isThinkingTokensLine } = require('../scripts/shared/strip-thinking-token-lines');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-strip-thinking-token-lines-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const THINKING_TOKENS_LINE = '{"type":"system","subtype":"thinking_tokens","estimated_tokens":348,"estimated_tokens_delta":1,"uuid":"69f55804-64c4-4dff-91df-2e7789e93951","session_id":"8cdb90e8-0d1e-4691-afdb-36b5b4d9f836"}';

describe('isThinkingTokensLine', () => {
  test('type=system かつ subtype=thinking_tokens の行を検出する', () => {
    assert.equal(isThinkingTokensLine(THINKING_TOKENS_LINE), true);
  });

  test('前後に空白があっても検出する', () => {
    assert.equal(isThinkingTokensLine(`  ${THINKING_TOKENS_LINE}  `), true);
  });

  test('subtypeが異なるsystemイベントは残す', () => {
    assert.equal(isThinkingTokensLine('{"type":"system","subtype":"init","session_id":"x"}'), false);
  });

  test('typeがsystem以外は残す', () => {
    assert.equal(isThinkingTokensLine('{"type":"assistant","subtype":"thinking_tokens"}'), false);
  });

  test('JSONとしてパースできない行は残す（フェイルオープン）', () => {
    assert.equal(isThinkingTokensLine('[gh-maestro] ワーカープロセスの起動でエラーが発生しました'), false);
  });

  test('空行は残す判定（filter対象外）', () => {
    assert.equal(isThinkingTokensLine('   '), false);
  });
});

describe('compactWorkerLog', () => {
  test('thinking_tokens行だけを取り除き、他の行は順序も内容も保つ', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      const initLine = '{"type":"system","subtype":"init","session_id":"x"}';
      const assistantLine = '{"type":"assistant","message":"hello"}';
      fs.writeFileSync(logPath, [
        initLine,
        THINKING_TOKENS_LINE,
        THINKING_TOKENS_LINE,
        assistantLine,
        THINKING_TOKENS_LINE,
      ].join('\n') + '\n');

      const result = compactWorkerLog(logPath);

      assert.equal(result.compacted, true);
      assert.equal(result.removedLines, 3);
      const kept = fs.readFileSync(logPath, 'utf8');
      assert.equal(kept, `${initLine}\n${assistantLine}\n`);
    });
  });

  test('雑音行が無ければファイルに触れない（変更なし判定）', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      const original = '{"type":"assistant","message":"hello"}\n';
      fs.writeFileSync(logPath, original);
      const before = fs.statSync(logPath).mtimeMs;

      const result = compactWorkerLog(logPath);

      assert.equal(result.compacted, false);
      assert.equal(result.removedLines, 0);
      assert.equal(fs.readFileSync(logPath, 'utf8'), original);
      assert.equal(fs.statSync(logPath).mtimeMs, before);
    });
  });

  test('末尾に改行が無いファイルでも壊さず処理する', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n{"type":"assistant","message":"hi"}`);

      const result = compactWorkerLog(logPath);

      assert.equal(result.compacted, true);
      assert.equal(fs.readFileSync(logPath, 'utf8'), '{"type":"assistant","message":"hi"}\n');
    });
  });

  test('全行が雑音の場合は空ファイルになる', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n${THINKING_TOKENS_LINE}\n`);

      const result = compactWorkerLog(logPath);

      assert.equal(result.compacted, true);
      assert.equal(result.removedLines, 2);
      assert.equal(fs.readFileSync(logPath, 'utf8'), '');
    });
  });

  test('存在しないファイルは静かに no-op を返す', () => {
    const result = compactWorkerLog('/definitely/does/not/exist.log');
    assert.equal(result.compacted, false);
    assert.equal(result.removedLines, 0);
  });

  test('空ファイルは no-op', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      fs.writeFileSync(logPath, '');
      const result = compactWorkerLog(logPath);
      assert.equal(result.compacted, false);
    });
  });

  test('一時ファイル(.tmp)を残さない', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n{"type":"assistant","message":"hi"}\n`);
      compactWorkerLog(logPath);
      const entries = fs.readdirSync(dir);
      assert.deepEqual(entries, ['worker.log']);
    });
  });

  test('rename失敗時も圧縮tmpを残さず、次回sweepで再試行できる', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n{"type":"assistant","message":"hi"}\n`);
      const originalRename = fs.renameSync;
      fs.renameSync = () => { throw new Error('simulated sharing violation'); };
      try {
        assert.throws(() => compactWorkerLog(logPath), /sharing violation/);
      } finally {
        fs.renameSync = originalRename;
      }
      assert.deepEqual(fs.readdirSync(dir), ['worker.log']);
    });
  });

  test('renameが一時的にEPERMで失敗しても共有リトライが成功させ、ノイズ行が実際に消える', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      const realLine = '{"type":"assistant","message":"hello"}';
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n${realLine}\n${THINKING_TOKENS_LINE}\n`);
      const originalRename = fs.renameSync;
      let renameAttempts = 0;
      // 圧縮の置き換え（.compact- tmp → worker.log）にだけ失敗を注入する。
      // 1回目だけ EPERM で失敗し、2回目で成功する（Windowsのハンドル解放遅延を模す）。
      fs.renameSync = (from, to) => {
        if (String(from).includes('.compact-')) {
          if (renameAttempts++ === 0) {
            const err = new Error('simulated sharing violation (EPERM)');
            err.code = 'EPERM';
            throw err;
          }
        }
        return originalRename(from, to);
      };
      let result;
      try {
        result = compactWorkerLog(logPath);
      } finally {
        fs.renameSync = originalRename;
      }
      assert.equal(result.compacted, true);
      assert.equal(result.removedLines, 2);
      // リトライ成功後はログからノイズ行が実際に消えている（例外が飛ばないことの確認では不十分）
      assert.equal(fs.readFileSync(logPath, 'utf8'), `${realLine}\n`);
    });
  });

  test('renameが最後まで失敗したら、失敗がログファイル自体に記録されノイズ行が残る', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      const realLine = '{"type":"assistant","message":"hi"}';
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n${realLine}\n`);
      const originalRename = fs.renameSync;
      // リトライ予算（合計500ms）を使い切るまで毎回 EPERM で失敗する
      fs.renameSync = (from, to) => {
        if (String(from).includes('.compact-')) {
          const err = new Error('simulated sharing violation (EPERM)');
          err.code = 'EPERM';
          throw err;
        }
        return originalRename(from, to);
      };
      try {
        assert.throws(() => compactWorkerLog(logPath), /EPERM/);
      } finally {
        fs.renameSync = originalRename;
      }
      // 失敗がログ自体に残り、あとからログを開いた人間に分かる（stderr経由に依存しない）
      const content = fs.readFileSync(logPath, 'utf8');
      assert.match(content, /ログ圧縮に失敗しました/);
      assert.ok(content.includes(THINKING_TOKENS_LINE), 'ノイズ行が残っている');
      assert.ok(content.includes(realLine), '実質行も残っている');
      // tmp残骸は残らない
      assert.deepEqual(fs.readdirSync(dir), ['worker.log']);
    });
  });

  test('非リトライ可能なエラーはリトライせず1回で諦める（一時的でないエラーを無駄にやり直さない）', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n{"type":"assistant","message":"hi"}\n`);
      const originalRename = fs.renameSync;
      let calls = 0;
      fs.renameSync = (from, to) => {
        if (String(from).includes('.compact-')) {
          calls++;
          const err = new Error('target is a directory');
          err.code = 'EISDIR';
          throw err;
        }
        return originalRename(from, to);
      };
      try {
        assert.throws(() => compactWorkerLog(logPath), (e) => e.code === 'EISDIR');
      } finally {
        fs.renameSync = originalRename;
      }
      assert.equal(calls, 1, '非リトライ可能エラー（EACCES/EPERM/EBUSY 以外）はリトライしない');
      // 最終失敗はログ自体に記録される
      assert.match(fs.readFileSync(logPath, 'utf8'), /ログ圧縮に失敗しました/);
    });
  });

  test('writeFileSync失敗時も圧縮tmpを残さない（try/finally化の検証、Issue #248 項目10）', () => {
    withTempDir((dir) => {
      const logPath = path.join(dir, 'worker.log');
      fs.writeFileSync(logPath, `${THINKING_TOKENS_LINE}\n{"type":"assistant","message":"hi"}\n`);
      const originalWrite = fs.writeFileSync;
      // 圧縮tmpの書き込みだけを失敗させる（成功時の書き込みは通す）。
      fs.writeFileSync = (target, ...args) => {
        if (String(target).includes('.compact-')) throw new Error('simulated write failure');
        originalWrite(target, ...args);
      };
      try {
        assert.throws(() => compactWorkerLog(logPath), /simulated write failure/);
      } finally {
        fs.writeFileSync = originalWrite;
      }
      // tmpが残らず、元ログも触られていない
      assert.deepEqual(fs.readdirSync(dir), ['worker.log']);
      assert.equal(fs.readFileSync(logPath, 'utf8'), `${THINKING_TOKENS_LINE}\n{"type":"assistant","message":"hi"}\n`);
    });
  });
});
