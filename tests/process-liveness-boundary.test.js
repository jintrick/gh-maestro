'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const forbidden = new Set(['isProcessAlive', 'verifyProcessIdentity', 'getProcessStartTime', 'captureProcessIdentity', 'startTimesMatch', 'createDeadManSwitch']);
function violations(source, allowStopBarrier = false) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', ecmaFeatures: { globalReturn: true }, loc: true });
  const found = [];
  const walk = (node, functionName = null) => {
    if (node && node.type === 'FunctionDeclaration') functionName = node.id?.name || null;
    if (!node || typeof node !== 'object') return;
    if (allowStopBarrier && node.type === 'Identifier' && node.name === 'hasNotExited' && functionName !== 'hasNotExited' && functionName !== 'waitForPidsToExit') found.push(`${node.loc.start.line}: teardown probe outside barrier`);
    if (node.type === 'Identifier' && [...forbidden].some(name => node.name.toLowerCase().includes(name.toLowerCase()))) found.push(`${node.loc.start.line}: ${node.name}`);
    if (node.type === 'TemplateElement' && /CreationDate|\/proc\/.*stat/i.test(node.value.raw)) found.push(`${node.loc.start.line}: direct start-time lookup`);
    if (node.type === 'Literal' && typeof node.value === 'string' && /CreationDate|\/proc\/.*stat/i.test(node.value)) found.push(`${node.loc.start.line}: direct start-time lookup`);
    if (node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal' && forbidden.has(node.property.value)) found.push(`${node.loc.start.line}: ${node.property.value}`);
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier' && node.callee.object.name === 'process'
        && ((node.callee.property.name || node.callee.property.value) === 'kill')
        && node.arguments[1]?.type === 'Literal' && node.arguments[1].value === 0
        && !(allowStopBarrier && functionName === 'hasNotExited')) found.push(`${node.loc.start.line}: process.kill(pid, 0)`);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'range') continue;
      if (Array.isArray(value)) for (const child of value) walk(child, functionName);
      else if (value && typeof value === 'object') walk(value, functionName);
    }
  };
  walk(ast);
  return found;
}
function scripts(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return scripts(file);
    return entry.isFile() && file.endsWith('.js') ? [file] : [];
  });
}
test('境界検査は直接呼び出し、別名、ブラケット参照を検出し停止シグナルを許容する', () => {
  assert.ok(violations('process.kill(pid, 0)').length);
  assert.ok(violations("const { isProcessAlive: probe } = require('./x'); probe(pid)").length);
  assert.ok(violations("lifecycle['verifyProcessIdentity'](pid, record)").length);
  assert.ok(violations('const lookup = getProcessStartTime; lookup(pid)').length);
  assert.ok(violations('`powershell CreationDate`').length);
  assert.deepEqual(violations("process.kill(pid, 'SIGTERM')"), []);
  assert.deepEqual(violations('function hasNotExited(pid) { process.kill(pid, 0); }', true), []);
  assert.ok(violations('function unrelated(pid) { process.kill(pid, 0); }', true).length);
  assert.ok(violations('function unrelated(pid) { hasNotExited(pid); }', true).length);
});
test('生存確認の低レベル操作は共通モジュールと停止直後の待機だけに閉じる', () => {
  const root = path.resolve(__dirname, '..');
  const issues = [];
  for (const file of scripts(path.join(root, 'scripts'))) {
    const relative = path.relative(root, file).replace(/\\/g, '/');
    if (relative === 'scripts/shared/process-liveness.js') continue;
    const matches = violations(fs.readFileSync(file, 'utf8'), relative === 'scripts/shared/kill-tree.js');
    for (const match of matches) issues.push(`${relative}:${match}`);
  }
  assert.deepEqual(issues, []);
});
