'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 実行ファイル名ghを維持したまま、テスト用の決定論的な応答を返すfixture。
 * セッションhookのrepo viewと、get-contextのfreshness用gh apiの両方で使う。
 */
function createFakeGh(binDir, { fail = false, apiResponses = {} } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const source = [
    "'use strict';",
    `const fail = ${JSON.stringify(Boolean(fail))};`,
    `const apiResponses = ${JSON.stringify(apiResponses)};`,
    "const path = require('path');",
    "const args = process.argv.slice(1);",
    "const command = path.basename(args[0] || '');",
    "const failWith = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };",
    "if (command === 'repo' && args[1] === 'view') {",
    "  if (!fail) {",
    "    process.stdout.write('example/gh-maestro-test\\n');",
    '    process.exit(0);',
    '  }',
    "  failWith('fake gh failure');",
    '}',
    "if (command === 'api') {",
    "  if (fail) failWith('fake gh failure');",
    "  const endpoint = args[1] || '';",
    "  if (endpoint.includes('/branches/')) {",
    "    process.stdout.write(String(apiResponses.branchSha || 'a'.repeat(40)) + '\\n');",
    '    process.exit(0);',
    '  }',
    "  if (endpoint.includes('/compare/')) {",
    "    const behindBy = Number.isSafeInteger(apiResponses.behindBy) ? apiResponses.behindBy : 0;",
    "    process.stdout.write(String(behindBy) + '\\n');",
    '    process.exit(0);',
    '  }',
    "  failWith('fake gh unknown api endpoint: ' + endpoint);",
    '}',
    // NODE_OPTIONS is inherited by the parent Node process as well as the copied
    // gh executable. Leave unrelated Node invocations alone.
    '',
  ].join('\n');

  const bootstrapPath = path.join(binDir, 'fake-gh-bootstrap.js');
  const ghPath = path.join(binDir, process.platform === 'win32' ? 'gh.exe' : 'gh');
  fs.writeFileSync(bootstrapPath, source, 'utf8');
  // reset-session.js and freshness-status.js invoke the real executable name `gh`
  // without a shell. A copied Node executable plus NODE_OPTIONS provides a
  // cross-platform executable replacement without relying on .cmd/.bat resolution.
  fs.copyFileSync(process.execPath, ghPath);
  if (process.platform !== 'win32') fs.chmodSync(ghPath, 0o755);
  return bootstrapPath;
}

function hookEnv(binDir, runtimeDir, bootstrapPath, baseEnv = process.env) {
  return {
    ...baseEnv,
    PATH: `${binDir}${path.delimiter}${baseEnv.PATH || ''}`,
    GH_MAESTRO_RUNTIME_DIR: runtimeDir,
    ...(bootstrapPath ? { NODE_OPTIONS: `--require=${bootstrapPath}` } : {}),
  };
}

module.exports = { createFakeGh, hookEnv };
