---
paths:
  - "scripts/**"
  - "tests/finalize-issue.test.js"
---

# 手書きargvパースの落とし穴

`scripts/`配下の多くのCLIスクリプトは外部ライブラリを使わず`argv.includes()`/独自の`getArg()`で引数を解析している。この方式は以下の不具合を繰り返し発生させている。

- **フラグ/値の衝突**: `argv.includes('--help')`のように生の`argv`全体を見てフラグ判定すると、他のオプションの値がたまたま`"--help"`等のフラグ文字列と一致した場合に誤判定する（例: `create-issue.js --title "--help"`が意図せずhelp表示になる。`spawn-worker.js`にも同型のパターンあり。PR #85 Review Manager指摘で発覚）。値として消費したトークンはフラグ判定対象から除外すること。parseFlags を catch した際のヘルプ判定は生の `argv.includes('--help')` でなく `err.helpRequested` を使う（parseFlags が throw 時に確定済み。値欠落エラーが混ざっている間は false になり、`--help` を値として渡された場合にヘルプへ握りつぶさない。旧実装の `exitFlagMiss` 先行判定と同じ意味論。判定述語は `scripts/shared/workspace.js` の `hasGenuineHelpRequest`）。
- **余分な位置引数の無視**: 想定外の位置引数を無言で無視すると、呼び出し側の誤用（引数の数え間違い等）に気づけない。位置引数の個数を検証し、想定外ならエラーにする。
- **`--stdin`等の標準入力待ちオプション**: パイプ/リダイレクトなしで対話的に呼び出されるとハングする。`process.stdin.isTTY`をチェックし、TTYならエラーで即終了する。

対策: 新規CLIスクリプトを書く、または既存スクリプトの引数パースを変更する際は、仕様駆動の単一パスパーサ `scripts/shared/workspace.js::parseFlags(args, spec)` を使う（`spec = { flags: {'--x': {required, hint}}, booleans: [...], positionals: {min, max} }`。値欠落・必須欠落・未知フラグ・位置引数違反は `ArgsValidationError` を throw し、`errors` 配列の `kind` で分類される）。8スクリプトがそれぞれ独自パーサーを書いて重複した経緯があるため（PR #89 Review Manager指摘）、新規に手書きパーサーを追加しない。旧形式 `parseFlags(args, flags, booleanFlags)` は Issue #275 で廃止（呼び出し側の null.trim() 事故を解消するため、未指定フラグはキー不在=undefined になり検証エラーは throw）。

- **同一スクリプト内での二重実装**: 起動前チェック（preflight）とメイン処理（`main()`）等、1つのスクリプト内に引数解析ロジックが2箇所以上あると、片方だけ修正されて解析結果が乖離する（例: preflightは古い判定のまま、`main()`だけ新フラグに対応）。解析は1箇所（1つのヘルパー呼び出し）に集約し、その結果を全箇所で再利用する（PR #90 Review Manager指摘）。
- **オプションテーブル方式での変数競合**: 複数の値ありフラグを1つの共通ループで処理する際、フラグ名を区別せず単一の変数に代入すると、後から追加した値ありフラグが既存フラグの結果を上書きしてしまう（例: `--body`用の変数に`--workspace`の値が混入する）。フラグごとに代入先を分ける、またはMapに`{フラグ名: 値}`で格納する（PR #95 Review Manager指摘）。
- **先頭の未消費フラグを正当な位置引数として誤受理**: 位置引数を1つ以上受理するスクリプトで、余分な位置引数の個数だけを検証すると、未知フラグ（`--`始まり）が唯一の位置引数として通過してしまう（例: `msg-poll.js --bogus --issue 5`で`--bogus`がworker名として受理される。PR #216 Review Manager指摘）。位置引数として採用する前に、その値が`--`で始まる未消費トークンでないか検証すること。
- **注入モックによる子プロセス境界のバイパス**: 兄弟CLIを`spawnSync`等で呼ぶ関数を、テストが常に依存注入で差し替えていると、渡しているargvは一度も検証されない。呼ばれる側のCLIが引数規約を変えても、呼ぶ側が旧規約のままでも、両者のテストは緑のまま通る（PR #330: `remove-worker.js`を位置引数化した際、`finalize-issue.js`側のargvを検証するテストが存在しなかった。Review Manager指摘）。注入は残してよいが、実物を通してargvと受理を一緒に固定するケースを最低1本持つこと。
