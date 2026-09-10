#!/usr/bin/env node
'use strict';

// run-tests.js — 宣言されたテスト層の実行と結果成果物の生成を一体化する。
//
// このスクリプト自身が runtime root へ成果物を書き出すため、コーダーが fail/pass を
// 数えて申告コマンドへ入力する経路はない。子プロセスの終了コードを基本の結果とし、
// 起動前異常終了を示すプロセス／出力の証拠がある場合だけ unavailable として保存する。
// 読めるテスト件数は付加情報として保存する。

const { spawnSync } = require('./shared/child-process');
const { resolveGitHead } = require('./shared/git-head');
const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { resolveTestConfig } = require('./shared/resolve-config');
const {
  TEST_RESULT_SCHEMA_VERSION,
  TEST_RESULT_PRODUCER,
  TEST_RESULT_PROVENANCE,
  calculateWorktreeContentHash,
  parseTapSummary,
  invalidateTestResultArtifact,
  writeTestResultLayer,
} = require('./shared/test-result');

const SLOW_TEST_ACTORS = Object.freeze(new Set(['poll-pr', 'run-slow-tests']));

const USAGE = `run-tests.js — 宣言されたテスト層を実行し、結果成果物を生成する

Usage:
  node run-tests.js [--workspace <path>] --list
  node run-tests.js [--workspace <path>] [--changed] <layer> [path ...]

Arguments:
  layer                 宣言されたテスト層の名前
  path                  通常は partial 層へ渡す相対テストファイル（任意）。--changed
                        指定時は変更した相対ファイルとして mapping へ渡す

Options:
  --workspace <path>   テスト層を解決するworkspace（省略時は環境/CWDから解決）
  --list               宣言された層の名前とscopeをJSONで一覧表示する。層は実行しない
  --changed             後続の path を変更ファイルとして mapping でテストへ変換する

Output:
  --list は status と層ごとの name / scope だけをJSONで出力します。
  --list の exit 0 = 宣言あり、exit 2 = 宣言なし、exit 1 = 解決失敗です。
  宣言されたコマンドの出力をそのまま標準出力/標準エラーへ中継します。
  結果は storage-layout.js の runtime root に worktree 単位で保存します。
  テストが失敗しても、終了コードと成果物の生成に成功した場合はその結果を保存します。
  exit 0 = 宣言コマンド成功、exit 1以上 = 宣言コマンド失敗または起動失敗`;

const SPEC = {
  flags: { '--workspace': {} },
  booleans: ['--help', '-h', '--changed', '--list'],
  positionals: { min: 0, max: 65 },
};

function normalizeRelativeTestFile(file) {
  if (typeof file !== 'string' || !file.trim()) {
    return { ok: false, error: `テストファイルは空でない相対パスで指定してください: ${file}` };
  }
  const normalized = file.replaceAll('\\', '/');
  if (normalized.includes('\0') || /[\r\n]/.test(normalized)
      || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return { ok: false, error: `テストファイルはworktree内の相対パスで指定してください: ${file}` };
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { ok: false, error: `テストファイルに不正なパス要素があります: ${file}` };
  }
  return { ok: true, value: normalized };
}

function normalizeTestFiles(testFiles, layer = {}) {
  if (!Array.isArray(testFiles)) return { ok: false, error: 'testFiles must be an array' };
  const files = [];
  const seen = new Set();
  for (const file of testFiles) {
    const normalized = normalizeRelativeTestFile(file);
    if (!normalized.ok) return normalized;
    if (layer.testFilePattern && !matchesTestFilePattern(layer.testFilePattern, normalized.value)) {
      return {
        ok: false,
        error: `テストファイルは${layer.testFilePattern}の形式で必要です: ${file}`,
      };
    }
    if (!seen.has(normalized.value)) {
      seen.add(normalized.value);
      files.push(normalized.value);
    }
  }
  return { ok: true, files };
}

function matchesTestFilePattern(pattern, file) {
  if (pattern.includes('<name>')) return matchChangedFile(pattern, file) !== null;
  const wildcardIndex = pattern.indexOf('*');
  if (wildcardIndex < 0) return pattern === file;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  const middle = file.slice(prefix.length, file.length - suffix.length);
  return file.startsWith(prefix) && file.endsWith(suffix) && Boolean(middle) && !middle.includes('/');
}

function matchChangedFile(pattern, changedFile) {
  const placeholderIndex = pattern.indexOf('<name>');
  if (placeholderIndex < 0) return pattern === changedFile ? '' : null;
  const prefix = pattern.slice(0, placeholderIndex);
  const suffix = pattern.slice(placeholderIndex + '<name>'.length);
  if (!changedFile.startsWith(prefix) || !changedFile.endsWith(suffix)) return null;
  const name = changedFile.slice(prefix.length, changedFile.length - suffix.length);
  if (!name || name.includes('/')) return null;
  return name;
}

/**
 * 変更ファイル一覧を宣言済みmappingからpartialテストファイル一覧へ変換する。
 * この関数はファイルを実行せず、相対パスの検証と `<name>` 展開だけを行う。
 * @param {string[]} changedFiles
 * @param {Array<{changed:string,test:string}>} mapping
 * @returns {{ok:true,files:string[]}|{ok:false,error:string}}
 */
function mapChangedFilesToTests(changedFiles, mapping) {
  if (!Array.isArray(changedFiles)) return { ok: false, error: 'changedFiles must be an array' };
  if (!Array.isArray(mapping)) return { ok: true, files: [] };

  const files = [];
  const seen = new Set();
  for (const rawChangedFile of changedFiles) {
    const changed = normalizeRelativeTestFile(rawChangedFile);
    if (!changed.ok) return changed;
    for (const rule of mapping) {
      if (!rule || typeof rule.changed !== 'string' || typeof rule.test !== 'string') continue;
      const name = matchChangedFile(rule.changed, changed.value);
      if (name === null) continue;
      const testFile = rule.test.replace('<name>', name);
      const normalizedTest = normalizeRelativeTestFile(testFile);
      if (!normalizedTest.ok) return normalizedTest;
      if (!seen.has(normalizedTest.value)) {
        seen.add(normalizedTest.value);
        files.push(normalizedTest.value);
      }
    }
  }
  return { ok: true, files };
}

function findFullLayer(testConfig) {
  const candidates = Object.entries(testConfig?.layers || {})
    .filter(([, layer]) => layer && layer.scope === 'full');
  return candidates.length === 1
    ? { name: candidates[0][0], layer: candidates[0][1] }
    : null;
}

function commandDisplay(command, displayCommand) {
  if (typeof displayCommand === 'string' && displayCommand.trim()) return displayCommand;
  return command.map((arg) => /[\s"']/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
}

const STARTUP_FAILURE_PATTERNS = Object.freeze([
  /\bCannot find module\b/i,
  /\bCannot find package\b/i,
  /\bMODULE_NOT_FOUND\b/i,
  /\bERR_MODULE_NOT_FOUND\b/i,
  /\bModuleNotFoundError\b/i,
  /\bspawn(?:Sync)?\b[^\r\n]*\bENOENT\b/i,
  /\bcommand not found\b/i,
  /\bexecutable file not found\b/i,
  /\bNo such file or directory\b/i,
]);

function truncateDiagnostic(value, maxLength = 4000) {
  const text = outputText(value).trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function runnerDiagnostic({ displayCommand, child, stdout, stderr }) {
  const details = [`command: ${displayCommand}`];
  if (child && child.error) {
    const errorMessage = child.error && child.error.message
      ? child.error.message : String(child.error);
    details.push(`error: ${truncateDiagnostic(errorMessage)}`);
  }
  if (child && Number.isInteger(child.status)) details.push(`exit code: ${child.status}`);
  if (child && child.signal) details.push(`signal: ${child.signal}`);
  const stderrText = truncateDiagnostic(stderr);
  const stdoutText = truncateDiagnostic(stdout);
  if (stderrText) details.push(`stderr: ${stderrText}`);
  if (stdoutText) details.push(`stdout: ${stdoutText}`);
  return details.join('; ');
}

/**
 * 子プロセスがテストを実行する前に異常終了したことを示す場合だけ、
 * complete/fail の分類を unavailable へ倒す。TAP以外のランナーについては、
 * 非空の独自失敗出力を実行後の失敗として保持し、出力形式を仮定しない。
 */
function classifyRunnerUnavailable({ child, childExitCode, stdout, stderr, summary, summaryFields, displayCommand }) {
  if (child && child.error) {
    return `runner-start-failed: ${runnerDiagnostic({ displayCommand, child, stdout, stderr })}`;
  }
  if (childExitCode === null) {
    return `runner-start-failed: ${runnerDiagnostic({ displayCommand, child, stdout, stderr })}`;
  }
  if (childExitCode === 0) return null;

  const combinedOutput = `${stdout}\n${stderr}`;
  const hasTestExecutionEvidence = summary.ok && summaryFields.tests > 0;
  if (hasTestExecutionEvidence) return null;
  const hasKnownStartupFailure = STARTUP_FAILURE_PATTERNS.some((pattern) => pattern.test(combinedOutput));
  const hasZeroTestSummary = summary.ok && summaryFields.tests === 0;
  if (!combinedOutput.trim() || hasKnownStartupFailure || hasZeroTestSummary) {
    return `runner-abnormal-exit: ${runnerDiagnostic({ displayCommand, child, stdout, stderr })}`;
  }
  return null;
}

function clearPreviousArtifact(worktree) {
  // 層別成果物の他層を壊さない。古い成果物の無効化は、実行結果を原子的に書けた
  // writeTestResultLayer 側でのみ解除する。
  void worktree;
}

function isSlowLayer(layerName) {
  return layerName === 'slow';
}

function authorizeLayerExecution(layerName, env) {
  if (!isSlowLayer(layerName)) return null;
  const actor = env && env.GH_MAESTRO_TEST_ACTOR;
  if (!SLOW_TEST_ACTORS.has(actor)) {
    return 'slow 層はコーダーの通常経路から実行できません。認可された実行主体だけが実行できます';
  }
  return null;
}

function exitCodeForChild(result) {
  if (result && Number.isInteger(result.status) && result.status >= 0) return result.status;
  return 1;
}

function outputText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function configuredTestArgs(layer, testFiles) {
  if (testFiles.length > 0 && layer.scope !== 'partial') {
    throw new Error('個別のテストファイル指定は partial 層でのみ使用できます');
  }
  const files = testFiles.length > 0
    ? testFiles
    : (Array.isArray(layer.defaultTestFiles) ? layer.defaultTestFiles : []);
  return [...(layer.command || []).slice(1), ...(layer.fileArgs || []), ...files];
}

function resolveConfigWorkspace(cwd, workspace, env = process.env) {
  if (workspace !== undefined) return resolveWorkspace(workspace);
  if (env && env.GH_MAESTRO_WORKSPACE) return resolveWorkspace(env.GH_MAESTRO_WORKSPACE);
  return cwd;
}

function layerListResult(status, layers, exitCode, stderr = '') {
  return {
    exitCode,
    stdout: `${JSON.stringify({ status, layers })}\n`,
    stderr,
  };
}

/**
 * 宣言されたテスト層を、実行に必要な最小限の情報だけで一覧表示する。
 *
 * 組み込み既定値だけが解決された場合は、コーダーが宣言済み層と誤認しないよう
 * 層を返さず missing とする。層の実行主体認可は実行入口の runTests() に限り、
 * この読み取り専用入口では行わない。
 *
 * @param {{cwd?:string, workspace?:string, homedir?:string, env?:object}} params
 * @param {{resolveTestConfigFn?:Function}} deps
 * @returns {{exitCode:number, stdout:string, stderr:string}}
 */
function listTestLayers({ cwd = process.cwd(), workspace, homedir, env = process.env } = {}, deps = {}) {
  const resolveTestConfigFn = deps.resolveTestConfigFn || resolveTestConfig;
  let executionWorkspace;
  try {
    executionWorkspace = resolveConfigWorkspace(cwd, workspace, env);
  } catch {
    return layerListResult('invalid', [], 1, 'テスト層を解決できません');
  }
  if (!executionWorkspace) {
    return layerListResult('invalid', [], 1, 'テスト層を解決するworkspaceを特定できません');
  }

  let testConfig;
  try {
    testConfig = resolveTestConfigFn({ workspace: executionWorkspace, homedir });
  } catch {
    testConfig = null;
  }
  if (!testConfig) return layerListResult('invalid', [], 1, 'テスト層の宣言を解決できません');
  if (testConfig.source !== 'declared') return layerListResult('missing', [], 2);

  const layers = Object.entries(testConfig.layers || {})
    .map(([name, layer]) => ({ name, scope: layer.scope }));
  return layerListResult('declared', layers, 0);
}

/**
 * 宣言されたテスト層を1回実行し、終了コードを結果の正本として成果物を作る。
 *
 * @param {{suite?:string, layer?:string, testFiles?:string[], changedFiles?:string[], cwd?:string, workspace?:string, env?:object, homedir?:string}} params
 * @param {object} [deps]
 * @param {Function} [deps.spawnSyncFn]
 * @param {Function} [deps.resolveTestConfigFn]
 * @param {Function} [deps.resolveGitHeadFn]
 * @param {Function} [deps.calculateWorktreeContentHashFn]
 * @param {Function} [deps.clearArtifactFn]
 * @param {Function} [deps.writeArtifactFn] (worktree, artifact) => void
 * @param {Function} [deps.writeStdoutFn]
 * @param {Function} [deps.writeStderrFn]
 * @returns {{exitCode:number, artifact:object|null, artifactWritten:boolean, stdout:string, stderr:string}}
 */
function runTests({ suite, layer, testFiles = [], changedFiles = [], cwd = process.cwd(), workspace, env = process.env, homedir } = {}, deps = {}) {
  const layerName = layer || suite;
  const authorizationError = authorizeLayerExecution(layerName, env);
  if (authorizationError) {
    return {
      exitCode: 1,
      artifact: null,
      artifactWritten: false,
      stdout: '',
      stderr: authorizationError,
    };
  }
  const resolveTestConfigFn = deps.resolveTestConfigFn || resolveTestConfig;
  let executionWorkspace;
  let testConfig;
  try {
    executionWorkspace = resolveConfigWorkspace(cwd, workspace, env);
    if (!executionWorkspace) {
      return {
        exitCode: 1,
        artifact: null,
        artifactWritten: false,
        stdout: '',
        stderr: 'テスト設定を読むworkspaceを解決できません',
      };
    }
    testConfig = resolveTestConfigFn({ workspace: executionWorkspace, homedir });
  } catch {
    testConfig = null;
  }
  let selected = testConfig && testConfig.layers && testConfig.layers[layerName];
  if (!selected) {
    return {
      exitCode: 1,
      artifact: null,
      artifactWritten: false,
      stdout: '',
      stderr: `未知のテストスイートまたはテスト層です: ${layerName}`,
    };
  }

  let normalizedFiles;
  try {
    if (testFiles.length === 0 && changedFiles.length > 0 && selected.scope === 'partial') {
      const mapped = mapChangedFilesToTests(changedFiles, selected.mapping);
      if (!mapped.ok) throw new Error(mapped.error);
      if (mapped.files.length > 0) {
        const normalizedMapped = normalizeTestFiles(mapped.files, selected);
        if (!normalizedMapped.ok) throw new Error(normalizedMapped.error);
        normalizedFiles = normalizedMapped.files;
      } else {
        const fallback = findFullLayer(testConfig);
        if (!fallback) {
          throw new Error('変更に対応するテストがなく、利用可能な唯一のfull層も解決できません');
        }
        selected = fallback.layer;
        normalizedFiles = [];
      }
    } else {
      const normalized = normalizeTestFiles(testFiles, selected);
      if (!normalized.ok) throw new Error(normalized.error);
      normalizedFiles = normalized.files;
    }
  } catch (error) {
    return {
      exitCode: 1,
      artifact: null,
      artifactWritten: false,
      stdout: '',
      stderr: error.message,
    };
  }

  let command;
  let commandArgs;
  try {
    command = selected.command[0];
    commandArgs = configuredTestArgs(selected, normalizedFiles);
  } catch (error) {
    return {
      exitCode: 1,
      artifact: null,
      artifactWritten: false,
      stdout: '',
      stderr: error.message,
    };
  }

  const spawnSyncFn = deps.spawnSyncFn || spawnSync;
  const resolveGitHeadFn = deps.resolveGitHeadFn || resolveGitHead;
  const calculateWorktreeContentHashFn = deps.calculateWorktreeContentHashFn || calculateWorktreeContentHash;
  const clearArtifactFn = deps.clearArtifactFn || clearPreviousArtifact;
  const invalidateArtifactFn = deps.invalidateArtifactFn || invalidateTestResultArtifact;
  const writeArtifactFn = deps.writeArtifactFn || writeTestResultLayer;
  const writeStdoutFn = deps.writeStdoutFn || ((text) => process.stdout.write(text));
  const writeStderrFn = deps.writeStderrFn || ((text) => process.stderr.write(text));

  try {
    clearArtifactFn(executionWorkspace);
  } catch (error) {
    try {
      invalidateArtifactFn(executionWorkspace, 'artifact-clear-failed');
    } catch (markerError) {
      writeStderrFn(`テスト結果成果物の失敗マーカーを書き出せません: ${markerError.message}\n`);
    }
    writeStderrFn(`テスト結果成果物の旧ファイルを削除できません: ${error.message}\n`);
    return {
      exitCode: 1,
      artifact: null,
      artifactWritten: false,
      stdout: '',
      stderr: `テスト結果成果物の旧ファイルを削除できません: ${error.message}`,
    };
  }

  let testedHead = null;
  try {
    testedHead = resolveGitHeadFn(executionWorkspace);
  } catch {
    // テストの成否にHEAD解決は不要。対象SHAは申告入口が現在のHEADから解決する。
  }

  let testedContentHash = null;
  let contentSnapshotError = null;
  try {
    // コマンド起動前の内容を記録する。テスト中に worktree が変更された場合、その変更を
    // 後続の git add -A がコミットしても、申告時の内容照合で unknown になる。
    testedContentHash = calculateWorktreeContentHashFn(executionWorkspace);
  } catch (error) {
    contentSnapshotError = error;
    writeStderrFn(`テスト対象内容の指紋を取得できません: ${error.message}\n`);
  }

  let child;
  try {
    child = spawnSyncFn(command, commandArgs, {
      cwd: executionWorkspace,
      env,
      encoding: 'utf8',
      shell: false,
    }) || {};
  } catch (error) {
    child = { status: null, error, stdout: '', stderr: '' };
  }
  const stdout = outputText(child.stdout);
  const stderr = outputText(child.stderr);
  if (stdout) writeStdoutFn(stdout);
  if (stderr) writeStderrFn(stderr);

  const summary = parseTapSummary(`${stdout}${stderr ? `\n${stderr}` : ''}`);
  // TAPの必須欄が揃っていても、framework固有の集計が成果物契約に収まらない場合は
  // 件数だけを捨てる。テスト実行後の非0終了は、summaryが不正でも終了コード由来の
  // failとして保持する。
  const summaryFields = summary.ok
    && summary.summary.pass + summary.summary.fail <= summary.summary.tests
    ? summary.summary
    : {};
  const childExitCode = child && Number.isInteger(child.status) && child.status >= 0
    ? child.status : null;
  const recordedAt = new Date().toISOString();
  const displayCommand = commandDisplay(
    [command, ...commandArgs],
    selected.displayCommand,
  );
  const runnerUnavailableReason = classifyRunnerUnavailable({
    child,
    childExitCode,
    stdout,
    stderr,
    summary,
    summaryFields,
    displayCommand,
  });
  let artifact;
  if (childExitCode !== null && testedContentHash && !runnerUnavailableReason) {
    artifact = {
      schemaVersion: TEST_RESULT_SCHEMA_VERSION,
      producer: TEST_RESULT_PRODUCER,
      provenance: TEST_RESULT_PROVENANCE,
      scope: selected.scope,
      status: 'complete',
      outcome: childExitCode === 0 ? 'pass' : 'fail',
      layer: layerName,
      command: displayCommand,
      recordedAt,
      executor: env.GH_MAESTRO_TEST_ACTOR || env.GH_MAESTRO_WORKER || 'local',
      testedHead,
      testedContentHash,
      ...summaryFields,
    };
  } else {
    artifact = {
      schemaVersion: TEST_RESULT_SCHEMA_VERSION,
      producer: TEST_RESULT_PRODUCER,
      provenance: TEST_RESULT_PROVENANCE,
      scope: selected.scope,
      status: 'unavailable',
      layer: layerName,
      command: displayCommand,
      recordedAt,
      executor: env.GH_MAESTRO_TEST_ACTOR || env.GH_MAESTRO_WORKER || 'local',
      testedHead,
      reason: contentSnapshotError
        ? 'content-snapshot-failed'
        : (runnerUnavailableReason || 'tap-summary-invalid'),
    };
  }
  if (env.GH_MAESTRO_TEST_LOG_PATH) artifact.executionLogPath = env.GH_MAESTRO_TEST_LOG_PATH;

  let artifactWritten = false;
  try {
    writeArtifactFn(executionWorkspace, artifact);
    artifactWritten = true;
  } catch (error) {
    try {
      invalidateArtifactFn(executionWorkspace, 'artifact-write-failed');
    } catch (markerError) {
      writeStderrFn(`テスト結果成果物の失敗マーカーを書き出せません: ${markerError.message}\n`);
    }
    writeStderrFn(`テスト結果成果物を書き出せません: ${error.message}\n`);
  }

  return {
    exitCode: exitCodeForChild(child),
    artifact,
    artifactWritten,
    stdout,
    stderr,
  };
}

function main(argv, deps = {}) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, SPEC));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) return { exitCode: 0, stdout: USAGE };
    return { exitCode: 1, stderr: `run-tests: ${err.errors.map(e => e.message).join('\n')}\n${USAGE}` };
  }

  if (values['--help'] || values['-h']) return { exitCode: 0, stdout: USAGE };

  if (values['--list']) {
    if (values['--changed'] || rest.length > 0) {
      return {
        exitCode: 1,
        stderr: `run-tests: --list は --changed や層名と併用できません\n${USAGE}`,
      };
    }
    const result = listTestLayers({
      workspace: values['--workspace'],
      cwd: process.cwd(),
      env: process.env,
      homedir: deps.homedir,
    }, deps);
    return result;
  }

  if (rest.length === 0) {
    return { exitCode: 1, stderr: `run-tests: 層名が必要です\n${USAGE}` };
  }

  const result = runTests({
    suite: rest[0],
    testFiles: values['--changed'] ? [] : rest.slice(1),
    changedFiles: values['--changed'] ? rest.slice(1) : [],
    workspace: values['--workspace'],
    cwd: process.cwd(),
    env: process.env,
  }, deps);
  return {
    exitCode: result.exitCode,
    stdout: '',
    stderr: result.artifact === null ? result.stderr : '',
  };
}

module.exports = {
  USAGE,
  SPEC,
  SLOW_TEST_ACTORS,
  authorizeLayerExecution,
  listTestLayers,
  normalizeRelativeTestFile,
  normalizeTestFiles,
  mapChangedFilesToTests,
  runTests,
  main,
};

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}
