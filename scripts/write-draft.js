#!/usr/bin/env node
// write-draft.js — 論理パス（/tmp/... 等）を実体パスへ解決してから草案ファイルを書き出す
// view-file.js・create-issue.js と同じ win-path.js の解決ロジックを通すことで、
// 書き込み先と参照先の実体パスがズレないようにする。
'use strict';

const fs = require('fs');
const path = require('path');
const { toWinPath } = require('./win-path');

const USAGE = `write-draft.js — 論理パスへ草案ファイルを書き出す（/tmp 等の論理パスを実体パスへ解決してから書き込む）

Usage:
  node write-draft.js <logical-path> --body <text>
  <content> | node write-draft.js <logical-path> --stdin

Arguments:
  <logical-path>  書き込み先の論理パス（例: /tmp/issue-draft.md）。win-path.js と同じ解決ロジックを通す
  --body <text>   書き込む内容を引数で渡す（改行を含む長文には不向き）
  --stdin         標準入力から内容を読み込んで書き込む（Bashのheredocと組み合わせて使う）

--body と --stdin はどちらか一方を必ず指定する。
このスクリプトは /tmp 配下への書き込み専用。解決後の実体パスが /tmp の実体（%TEMP%等）
配下から外れる場合はエラーで拒否する（"../" 等によるルート越え書き込みを防ぐ）。

Output (stdout):
  DRAFT_WRITTEN:<実体パス>  書き込み成功時。実体パスを常に表示する

親ディレクトリが無ければ作成する。既存ファイルは常に上書きする。
内容が空の場合は書き込まずエラー終了する（空ファイルによるサイレント失敗を防ぐ）。
失敗時は解決しようとした論理パス・実体パスの両方をstderrに出力する。`;

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// argv を1回だけ順に走査し、--body が消費した値をフラグ判定の対象から除外する。
// これをしないと --body '--help' のような値そのものが誤ってフラグとして解釈される。
function parseArgs(argv) {
  let help = false;
  let stdin = false;
  let body;
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      help = true;
    } else if (a === '--stdin') {
      stdin = true;
    } else if (a === '--body') {
      body = argv[i + 1];
      i++;
    } else {
      positionals.push(a);
    }
  }

  return { help, stdin, body, positionals };
}

// 論理パスの実体解決先が /tmp の実体ルート配下に収まることを確認する。
// scripts/shared/review-manager-paths.js の「許可ルート配下チェック」パターンを踏襲。
function resolveDraftPath(logicalPath) {
  const allowedRoot = path.resolve(toWinPath('/tmp'));
  const resolved = path.resolve(toWinPath(logicalPath));
  if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) {
    throw new Error(`論理パスの解決先が許可ルート(/tmp)外です: ${logicalPath} → ${resolved}`);
  }
  return resolved;
}

// main() は process.exit() を呼ばず結果オブジェクトを返す。
// require.main === module の薄いエントリポイントだけが exit する。
function main(argv, { readStdinFn = readStdin, isStdinTTY = () => process.stdin.isTTY } = {}) {
  const { help, stdin: hasStdin, body: bodyArg, positionals } = parseArgs(argv);

  if (help) {
    return { code: 0, stdout: USAGE };
  }

  const hasBody = bodyArg !== undefined;

  if (
    positionals.length !== 1 ||
    (!hasStdin && !hasBody) ||
    (hasStdin && hasBody)
  ) {
    return { code: 1, stderr: USAGE };
  }
  const logicalPath = positionals[0];

  if (hasStdin && isStdinTTY()) {
    return {
      code: 1,
      stderr: '--stdin が指定されましたが標準入力がTTYです。パイプまたはheredocで内容を渡してください。',
    };
  }

  const content = hasStdin ? readStdinFn() : bodyArg;

  if (!content || content.length === 0) {
    return {
      code: 1,
      stderr: `内容が空です。書き込みを中止しました: 論理パス=${logicalPath}`,
    };
  }

  let absPath;
  try {
    absPath = resolveDraftPath(logicalPath);
  } catch (e) {
    return { code: 1, stderr: e.message };
  }
  const dir = path.dirname(absPath);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content);
  } catch (e) {
    return {
      code: 1,
      stderr: `書き込みに失敗しました: 論理パス=${logicalPath} 実体パス=${absPath}\n${e.message}`,
    };
  }

  return { code: 0, stdout: `DRAFT_WRITTEN:${absPath}` };
}

if (require.main === module) {
  const result = main(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}

module.exports = { main };
