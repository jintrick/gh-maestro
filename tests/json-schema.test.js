'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _validateAgainstSchema } = require('../scripts/shared/json-schema');

test('object: 有効な値を合格とする', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1 } },
  };
  assert.deepEqual(_validateAgainstSchema({ name: 'ok' }, schema), []);
});

test('object: required 欠落を検出する', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' } },
  };
  const errors = _validateAgainstSchema({}, schema);
  assert.ok(errors.some(e => e.includes("missing required 'name'")));
});

test('object: additionalProperties:false で未知フィールドを検出する', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string' } },
  };
  const errors = _validateAgainstSchema({ name: 'ok', extra: true }, schema);
  assert.ok(errors.some(e => e.includes("unexpected field 'extra'")));
});

test('object: 非オブジェクトは expected object', () => {
  const errors = _validateAgainstSchema(null, { type: 'object' });
  assert.deepEqual(errors, [': expected object']);
});

test('array: minItems を検出する', () => {
  const schema = { type: 'array', minItems: 2, items: { type: 'string' } };
  assert.deepEqual(_validateAgainstSchema(['a', 'b'], schema), []);
  const errors = _validateAgainstSchema(['a'], schema);
  assert.ok(errors.some(e => e.includes('>= 2 items')));
});

test('array: items を再帰検証し要素インデックスをパスに含める', () => {
  const schema = { type: 'array', items: { type: 'integer' } };
  const errors = _validateAgainstSchema([1, 'x'], schema);
  assert.ok(errors.some(e => e.includes('[1]: expected integer')));
});

test('string: minLength と enum を検出する', () => {
  assert.deepEqual(_validateAgainstSchema('x', { type: 'string', minLength: 1 }), []);
  const tooShort = _validateAgainstSchema('', { type: 'string', minLength: 1 });
  assert.ok(tooShort.some(e => e.includes('string too short')));

  const enumSchema = { type: 'string', enum: ['a', 'b'] };
  assert.deepEqual(_validateAgainstSchema('a', enumSchema), []);
  const invalidEnum = _validateAgainstSchema('c', enumSchema);
  assert.ok(invalidEnum.some(e => e.includes("invalid enum value 'c'")));
});

test('integer: 型と minimum を検出する', () => {
  assert.deepEqual(_validateAgainstSchema(3, { type: 'integer' }), []);
  assert.deepEqual(_validateAgainstSchema(3.5, { type: 'integer' }), [': expected integer']);
  const below = _validateAgainstSchema(2, { type: 'integer', minimum: 3 });
  assert.ok(below.some(e => e.includes('below minimum 3')));
});

test('ネストしたプロパティのエラーパスにドット連結されたパスを含める', () => {
  const schema = {
    type: 'object',
    required: ['inner'],
    properties: {
      inner: { type: 'object', required: ['x'], properties: { x: { type: 'integer' } } },
    },
  };
  const errors = _validateAgainstSchema({ inner: { x: 'bad' } }, schema);
  assert.ok(errors.some(e => e.includes('inner.x: expected integer')));
});

test('unknown type は検証しない（errorsを返さない）', () => {
  assert.deepEqual(_validateAgainstSchema(123, { type: 'unknown-type' }), []);
});
