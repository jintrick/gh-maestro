#!/usr/bin/env node
// view-file.js — Zed でファイルを開く
//
// Usage:
//   node view-file.js <filepath>

const { spawnSync } = require('child_process');
const path = require('path');

// win-path は常に同一ディレクトリに同居する（リポジトリの scripts/ もインストール先も）。
const { toWinPath } = require('./win-path');

const USAGE = `view-file.js — ファイルを Zed で開く（ユーザーに確認・承認してほしいファイルの提示用）

Usage: node view-file.js <filepath> [--workspace <path>]

Arguments:
  <filepath>  開くファイルのパス（/tmp 形式は OS 依存パスに変換される）

Issue 原案などをチャットで説明する前に、これでユーザーに見せる。`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const filePath = argv.find(a => !a.startsWith('--'));

if (!filePath) {
  console.error(USAGE);
  process.exit(1);
}

const absPath = path.resolve(toWinPath(filePath));
spawnSync('zed', [absPath], { stdio: 'inherit' });
