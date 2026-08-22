#!/usr/bin/env node
// stop-worker.js
// ワーカーのプロセスツリーのみを同一性確認の上で停止（kill）する。
// worktree、ブランチ、workers.jsonのエントリは保持し、再開（resume）可能な状態を保つ。
//
// Usage:
//   node stop-worker.js <workerName> [--workspace <path>]
//   node stop-worker.js --issue <N> --skill <role> [--workspace <path>]

const { parseFlags, resolveWorkspace } = require('./shared/workspace');
const { resolveWorkerName } = require('./shared/workers-registry');
const { stopWorkerProcess } = require('./shared/stop-worker-process');

const USAGE = `stop-worker.js — ワーカープロセスを同一性確認の上で停止する（worktree・ブランチ・エントリは保持）

Usage: node stop-worker.js <workerName> [--workspace <path>]
       node stop-worker.js --issue <N> --skill <role> [--workspace <path>]

Arguments:
  <workerName>           停止するワーカー名。--issue+--skill と併用不可。

Options:
  --issue <N>           停止対象ワーカーを workerName ではなく〈Issue番号 + 役割〉で指定する場合のIssue番号。
  --skill <role>        同上の役割（gh-maestro-coder等）。workers.json から一意に解決する。
                        該当が複数ある場合は候補を表示してエラー終了するので workerName（位置引数）で明示する。
  --workspace <path>    ワークスペース（省略時は GH_MAESTRO_WORKSPACE env または
                        CWDからの .gh-maestro/ 上方探索で解決）

workerName（位置引数）か〈--issue + --skill〉のいずれかで停止対象を指定する。
対象プロセスの同一性（起動時刻）を確認し、一致する場合のみプロセスツリーを kill する。
同一性が一致しない（PIDが別プロセスに再利用されている）場合はプロセスを kill せずエラー終了する。
作業ツリー・ブランチ・workers.json エントリは削除せずそのまま維持するため、後から resume で再開できる。`;

function main(argv = process.argv.slice(2)) {
  let values, rest;
  try {
    ({ values, rest } = parseFlags(argv, {
      flags: { '--workspace': {}, '--issue': {}, '--skill': {} },
      booleans: ['--help', '-h'],
      positionals: { min: 0, max: 1 },
    }));
  } catch (err) {
    if (err.name !== 'ArgsValidationError') throw err;
    if (err.helpRequested) {
      console.log(USAGE);
      return 0;
    }
    for (const e of err.errors) console.error(`stop-worker: ${e.message}`);
    console.error(USAGE);
    return 1;
  }

  if (values['--help'] || values['-h']) {
    console.log(USAGE);
    return 0;
  }

  const fail = (msg) => { console.error(`stop-worker: ${msg}`); return 1; };

  const workspace = resolveWorkspace(values['--workspace']);
  if (!workspace) return fail('ワークスペースを解決できません。--workspace を指定するか、.gh-maestro/ のあるディレクトリで実行してください。');

  let workerName = rest[0];
  if (workerName && (values['--issue'] || values['--skill'])) {
    return fail('workerName（位置引数）と〈--issue + --skill〉は併用できません。どちらか一方で指定してください。');
  }
  if (!workerName) {
    if (!values['--issue'] || !values['--skill']) {
      console.error(USAGE);
      return 1;
    }
    try {
      workerName = resolveWorkerName(workspace, { issue: values['--issue'], skill: values['--skill'] });
    } catch (e) {
      return fail(e.message);
    }
  }

  try {
    stopWorkerProcess(workspace, workerName, { isRemoveMode: false });
    return 0;
  } catch (e) {
    return fail(e.message);
  }
}

if (require.main === module) {
  const code = main();
  process.exit(code);
}

module.exports = { main, USAGE };
