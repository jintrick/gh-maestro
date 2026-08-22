'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_FORCE_IDENTITIES,
  isWorkerIdentity,
  isAllowedForceIdentity,
  checkResidentForceGuard,
} = require('../scripts/shared/resident-force-guard');

describe('resident-force-guard', () => {
  describe('isWorkerIdentity', () => {
    test('ワーカー名（issue-<N>-<role>-<desc>等）なら true', () => {
      assert.strictEqual(isWorkerIdentity('issue-384-coder-force-guard'), true);
      assert.strictEqual(isWorkerIdentity('issue-1-explorer-test'), true);
      assert.strictEqual(isWorkerIdentity('custom-worker'), true);
    });

    test('orchestrator または human なら false', () => {
      assert.strictEqual(isWorkerIdentity('orchestrator'), false);
      assert.strictEqual(isWorkerIdentity('human'), false);
      assert.strictEqual(isWorkerIdentity(' orchestrator '), false);
      assert.strictEqual(isWorkerIdentity(' human '), false);
    });

    test('未設定・空文字・非文字列なら false', () => {
      assert.strictEqual(isWorkerIdentity(undefined), false);
      assert.strictEqual(isWorkerIdentity(null), false);
      assert.strictEqual(isWorkerIdentity(''), false);
      assert.strictEqual(isWorkerIdentity('   '), false);
      assert.strictEqual(isWorkerIdentity(123), false);
    });
  });

  describe('isAllowedForceIdentity', () => {
    test('orchestrator または human なら true', () => {
      assert.strictEqual(isAllowedForceIdentity('orchestrator'), true);
      assert.strictEqual(isAllowedForceIdentity('human'), true);
      assert.strictEqual(isAllowedForceIdentity(' orchestrator '), true);
    });

    test('ワーカー名や未設定なら false', () => {
      assert.strictEqual(isAllowedForceIdentity('issue-384-coder-force-guard'), false);
      assert.strictEqual(isAllowedForceIdentity(''), false);
      assert.strictEqual(isAllowedForceIdentity(null), false);
      assert.strictEqual(isAllowedForceIdentity(undefined), false);
    });
  });

  describe('checkResidentForceGuard', () => {
    test('GH_MAESTRO_WORKER=orchestrator なら許可される', () => {
      const res = checkResidentForceGuard({ GH_MAESTRO_WORKER: 'orchestrator' });
      assert.strictEqual(res.allowed, true);
      assert.strictEqual(res.identity, 'orchestrator');
    });

    test('GH_MAESTRO_WORKER=human なら許可される', () => {
      const res = checkResidentForceGuard({ GH_MAESTRO_WORKER: 'human' });
      assert.strictEqual(res.allowed, true);
      assert.strictEqual(res.identity, 'human');
    });

    test('GH_MAESTRO_WORKER 未設定なら拒否される（フェイルクローズ）', () => {
      const res = checkResidentForceGuard({});
      assert.strictEqual(res.allowed, false);
      assert.strictEqual(res.reason, 'missing_identity');
      assert.ok(res.message.includes('理由'));
      assert.ok(res.message.includes('代替手順'));
      assert.ok(res.message.includes('禁止事項'));
      assert.ok(res.message.includes('一時ワークスペース'));
    });

    test('GH_MAESTRO_WORKER が空文字なら拒否される', () => {
      const res = checkResidentForceGuard({ GH_MAESTRO_WORKER: '  ' });
      assert.strictEqual(res.allowed, false);
      assert.strictEqual(res.reason, 'missing_identity');
    });

    test('GH_MAESTRO_WORKER がワーカー名なら拒否される', () => {
      const res = checkResidentForceGuard({ GH_MAESTRO_WORKER: 'issue-384-coder-force-guard' });
      assert.strictEqual(res.allowed, false);
      assert.strictEqual(res.reason, 'disallowed_worker');
      assert.strictEqual(res.workerName, 'issue-384-coder-force-guard');
      assert.ok(res.message.includes('issue-384-coder-force-guard'));
      assert.ok(res.message.includes('理由'));
      assert.ok(res.message.includes('代替手順'));
      assert.ok(res.message.includes('禁止事項'));
      assert.ok(res.message.includes('一時ワークスペース'));
    });

    test('GH_MAESTRO_WORKER が未知の役割でも許可リストに無ければ拒否される', () => {
      const res = checkResidentForceGuard({ GH_MAESTRO_WORKER: 'new-unknown-role' });
      assert.strictEqual(res.allowed, false);
      assert.strictEqual(res.reason, 'disallowed_worker');
    });
  });
});
