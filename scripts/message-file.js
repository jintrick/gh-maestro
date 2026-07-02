'use strict';
// send-pane.js の本文をファイルに退避するためのヘルパー。
//
// メッセージ本文を直接 wezterm cli send-text でキーストローク注入すると、
// 本文中の特殊文字（"@" によるファイルメンション補完トリガー等）がEnterを
// 消費してしまい、メッセージが未送信のままcomposerに残ることがある。
// 本文はファイルへ書き、pane には「このファイルを読んでください」という
// 固定テンプレートの短文だけを送ることで、この失敗クラスを構造的に排除する。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// メッセージ本文をmessagesDirへ書き、絶対パスを返す。
function writeMessageFile(messagesDir, content) {
  fs.mkdirSync(messagesDir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const filePath = path.join(messagesDir, `msg-${id}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// messagesDir内の古いメッセージファイルを削除する（ベストエフォート）。
// 読まれたかどうかは追跡しないため、十分読まれているはずの経過時間で単純に間引く。
function pruneOldMessageFiles(messagesDir, maxAgeMs) {
  let entries;
  try { entries = fs.readdirSync(messagesDir); } catch { return; }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith('msg-')) continue;
    const p = path.join(messagesDir, entry);
    try {
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
    } catch {
      // 他プロセスとの競合等で消せなくても無視する
    }
  }
}

module.exports = { writeMessageFile, pruneOldMessageFiles };
