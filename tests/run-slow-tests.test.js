'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TEST_ACTOR,
  USAGE,
  runSlowTests,
  main,
} = require('../scripts/run-slow-tests');

test('runSlowTests delegates the complete slow layer to run-tests.js', () => {
  let captured;
  const expected = {
    exitCode: 3,
    artifact: { layer: 'slow' },
    artifactWritten: true,
    stdout: 'runner output',
    stderr: 'runner error',
  };
  const result = runSlowTests({
    workspace: '/workspace',
    cwd: '/caller',
    env: { GH_MAESTRO_TEST_ACTOR: 'caller-supplied-value' },
  }, {
    runTestsFn: (params, deps) => {
      captured = { params, deps };
      return expected;
    },
  });

  assert.strictEqual(result, expected);
  assert.equal(captured.params.suite, 'slow');
  assert.deepEqual(captured.params.testFiles, []);
  assert.deepEqual(captured.params.changedFiles, []);
  assert.equal(captured.params.workspace, '/workspace');
  assert.equal(captured.params.cwd, '/caller');
  assert.equal(captured.params.env.GH_MAESTRO_TEST_ACTOR, TEST_ACTOR);
});

test('main: --help and -h return Usage without running the layer', () => {
  for (const flag of ['--help', '-h']) {
    const result = main([flag], {
      runTestsFn: () => { throw new Error('runner must not start for help'); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, USAGE);
  }
});

test('main: positional target is rejected because the entry always runs all slow tests', () => {
  const result = main(['tests/slow/config.test.js']);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Usage/);
});
