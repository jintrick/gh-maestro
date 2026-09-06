#!/usr/bin/env node
'use strict';

// run-tests.js — 宣言されたテスト層の実行と結果成果物の生成を一体化する。
//
// このスクリプト自身が runtime root へ成果物を書き出すため、コーダーが fail/pass を
// 数えて申告コマンドへ入力する経路はない。子プロセスの終了コードを結果の正本とし、
// 読めるテスト件数は付加情報として保存する。

const fs = require('fs');
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
  testResultPath,
  clearTestResultInvalidation,
  invalidateTestResultArtifact,
  writeTestResultArtifact,
} = require('./shared/test-result');

const USAGE = `run-tests.js — 宣言されたテスト層を実行し、結果成果物を生成する

Usage:
  node run-tests.js [--workspace <path>] [--changed] <layer> [path ...]

Arguments:
  layer                 config.json の test.layers にある層名。既定値は full / slow
  path                  通常は partial 層へ渡す相対テストファイル（任意）。--changed
                        指定時は変更した相対ファイルとして mapping へ渡す

Options:
  --workspace <path>   test.layers を読むプロジェクトのworkspace（省略時は環境/CWDから解決）
  --changed             後続の path を変更ファイルとして mapping でテストへ変換する

Output:
  宣言されたコマンドの出力をそのまま標準出力/標準エラーへ中継します。
  結果は storage-layout.js の runtime root に worktree 単位で保存します。
  テストが失敗しても、終了コードと成果物の生成に成功した場合はその結果を保存します。
  exit 0 = 宣言コマンド成功、exit 1以上 = 宣言コマンド失敗または起動失敗`;

const SPEC = {
  flags: { '--workspace': {} },
  booleans: ['--help', '-h', '--changed'],
  positionals: { min: 1, max: 65 },
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

function clearPreviousArtifact(worktree) {
  try {
    fs.unlinkSync(testResultPath(worktree));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  clearTestResultInvalidation(worktree);
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

function resolveConfigWorkspace(cwd, workspace) {
  if (workspace !== undefined) return resolveWorkspace(workspace);
  if (process.env.GH_MAESTRO_WORKSPACE) return resolveWorkspace(null);
  return cwd;
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
  const resolveTestConfigFn = deps.resolveTestConfigFn || resolveTestConfig;
  let executionWorkspace;
  let testConfig;
  try {
    executionWorkspace = resolveConfigWorkspace(cwd, workspace);
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
  const writeArtifactFn = deps.writeArtifactFn || writeTestResultArtifact;
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
  // 件数だけを捨てる。終了コード由来のoutcomeは、そのようなsummaryでも保持する。
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
  let artifact;
  if (childExitCode !== null && testedContentHash) {
    artifact = {
      schemaVersion: TEST_RESULT_SCHEMA_VERSION,
      producer: TEST_RESULT_PRODUCER,
      provenance: TEST_RESULT_PROVENANCE,
      scope: selected.scope,
      status: 'complete',
      outcome: childExitCode === 0 ? 'pass' : 'fail',
      command: displayCommand,
      recordedAt,
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
      command: displayCommand,
      recordedAt,
      testedHead,
      reason: contentSnapshotError
        ? 'content-snapshot-failed'
        : (child.error || childExitCode === null ? 'runner-start-failed' : 'tap-summary-invalid'),
    };
  }

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
