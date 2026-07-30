'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CONTRACT_TYPES, writeContract, readContract, clearContract, contractDir, contractPath } = require('../scripts/shared/response-contract');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-maestro-response-contract-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

describe('response-contract', () => {
  describe('writeContract / readContract', () => {
    test('書き込んだ契約を読み込める', () => {
      withTempDir((dir) => {
        const contract = { type: CONTRACT_TYPES.ARTIFACT_OR_MESSAGE, artifact: 'pr', issue: 194 };
        writeContract(dir, 'issue-194-senior-coder-test', contract);
        const read = readContract(dir, 'issue-194-senior-coder-test');
        assert.deepEqual(read, contract);
      });
    });

    test('存在しない契約は null を返す', () => {
      withTempDir((dir) => {
        assert.equal(readContract(dir, 'nonexistent-worker'), null);
      });
    });

    test('contractDirの配下にファイルが作成される', () => {
      withTempDir((dir) => {
        writeContract(dir, 'worker-x', { type: CONTRACT_TYPES.MESSAGE_REQUIRED });
        const expectedDir = contractDir(dir);
        const expectedPath = contractPath(dir, 'worker-x');
        assert.ok(fs.existsSync(expectedDir));
        assert.ok(fs.existsSync(expectedPath));
      });
    });

    test('type が文字列でない場合は null を返す（堅牢性）', () => {
      withTempDir((dir) => {
        const cp = contractPath(dir, 'bad-contract');
        fs.mkdirSync(path.dirname(cp), { recursive: true });
        fs.writeFileSync(cp, JSON.stringify({ type: 123 }), 'utf8');
        assert.equal(readContract(dir, 'bad-contract'), null);
      });
    });

    test('壊れたJSONファイルは null を返す（堅牢性）', () => {
      withTempDir((dir) => {
        const cp = contractPath(dir, 'corrupt-contract');
        fs.mkdirSync(path.dirname(cp), { recursive: true });
        fs.writeFileSync(cp, 'not valid json {{{', 'utf8');
        assert.equal(readContract(dir, 'corrupt-contract'), null);
      });
    });

    test('配列が入っている場合は null を返す（堅牢性）', () => {
      withTempDir((dir) => {
        const cp = contractPath(dir, 'array-contract');
        fs.mkdirSync(path.dirname(cp), { recursive: true });
        fs.writeFileSync(cp, JSON.stringify([1, 2, 3]), 'utf8');
        assert.equal(readContract(dir, 'array-contract'), null);
      });
    });

    test('再書き込みで内容が更新される', () => {
      withTempDir((dir) => {
        writeContract(dir, 'worker-y', { type: CONTRACT_TYPES.MESSAGE_REQUIRED });
        assert.equal(readContract(dir, 'worker-y').type, CONTRACT_TYPES.MESSAGE_REQUIRED);
        writeContract(dir, 'worker-y', { type: CONTRACT_TYPES.ARTIFACT_OR_MESSAGE, artifact: 'pr', issue: 42 });
        const updated = readContract(dir, 'worker-y');
        assert.equal(updated.type, CONTRACT_TYPES.ARTIFACT_OR_MESSAGE);
        assert.equal(updated.issue, 42);
      });
    });
  });

  describe('clearContract', () => {
    test('契約を削除できる', () => {
      withTempDir((dir) => {
        writeContract(dir, 'worker-z', { type: CONTRACT_TYPES.MESSAGE_REQUIRED });
        assert.notEqual(readContract(dir, 'worker-z'), null);
        clearContract(dir, 'worker-z');
        assert.equal(readContract(dir, 'worker-z'), null);
      });
    });

    test('存在しない契約の削除はエラーにならない（冪等）', () => {
      withTempDir((dir) => {
        clearContract(dir, 'nonexistent-worker');
        // エラーが投げられなければOK
      });
    });
  });

  describe('CONTRACT_TYPES', () => {
    test('定数が freeze されている', () => {
      assert.throws(() => { CONTRACT_TYPES.NEW_TYPE = 'test'; }, TypeError);
    });
  });
});
