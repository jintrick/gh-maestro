#!/usr/bin/env node
// view-file.js — Zed でファイルを開く
//
// Usage:
//   node view-file.js <filepath>

const { spawnSync } = require('child_process');
const path = require('path');
const { existsSync } = require('fs');

const winPathMod = existsSync(path.join(__dirname, 'win-path.js'))
  ? path.join(__dirname, 'win-path.js')
  : path.join(__dirname, '..', '..', '..', 'lib', 'win-path.js');
const { toWinPath } = require(winPathMod);

const filePath = process.argv.slice(2).find(a => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: node view-file.js <filepath>');
  process.exit(1);
}

const absPath = path.resolve(toWinPath(filePath));
spawnSync('zed', [absPath], { stdio: 'inherit' });
