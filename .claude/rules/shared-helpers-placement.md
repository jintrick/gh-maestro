---
paths:
  - "scripts/shared/*.js"
---

# scripts/shared/ への汎用ヘルパー追加時の置き場所

`scripts/shared/validate.js` は path-safety 検証（queue/msg-bus のパス構成要素検証）専用のファイルとして文書化・テストされている。汎用的な型判定・整形ヘルパー（例: `isPlainObject`）をここに追加すると、責務が混在し、path-safety の変更時に無関係な config 系コードを壊すリスクが生まれる（PR #83 Review指摘）。

- 汎用ヘルパーを追加する際は、既存ファイルの「ファイルヘッダー・テストが何を対象にしているか」を確認し、対象外なら流用しない。
- 置き場所に迷ったら、利用箇所が単一のモジュールに閉じるならそのモジュール内にローカル定義し、複数モジュールで共有するなら目的別の新規ファイル（例: `scripts/shared/object.js`）を作る。
