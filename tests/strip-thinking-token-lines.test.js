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
});
