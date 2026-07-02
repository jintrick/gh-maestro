'use strict';
// wezterm ペインへ「Enter」相当のキー入力を送信する。
//
// ペイン内で動くアプリの改行解釈（\r / \n / \r\n のどれが「送信」として認識されるか）は
// OS・端末モード（cooked/raw）・アプリ実装に依存し統一されていない。
// --no-paste 経由では wezterm 側の改行正規化（canonicalize_pasted_newlines）は
// 一切適用されないため、terminator は生バイトのままペインに渡る。
//
// 呼び出し元ごとに実績のあるterminatorが異なる（例: reasonixは'\n'、その他は'\r\n'）ため、
// 呼び出し元が明示的に terminator を指定できるようにしてある。

const { spawnSync } = require('./child-process');

function sendEnter(paneId, { terminator = '\r\n', send = null } = {}) {
  const invoke = send ?? ((...args) => spawnSync('wezterm', args, { encoding: 'utf8' }));
  return invoke('cli', 'send-text', '--pane-id', paneId, '--no-paste', terminator);
}

module.exports = { sendEnter };
