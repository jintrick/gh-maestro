---
source_url: agy -h (実行結果)
original_title: agy CLI コマンドラインフラグ・サブコマンドリファレンス
fetched_at: 2026-06-11
---

# agy CLI コマンドラインフラグ・サブコマンドリファレンス

`agy -h` の実行結果に基づく。

## フラグ一覧

| フラグ | 短縮形 | デフォルト | 説明 |
| :--- | :--- | :--- | :--- |
| `--continue` | `-c` | — | 直近のセッションを再開する |
| `--conversation <ID>` | — | — | 指定したIDのセッションを再開する |
| `--prompt-interactive <prompt>` | `-i` | — | 初期プロンプトを渡しつつインタラクティブセッションを起動する |
| `--print <prompt>` | `-p` | — | 非インタラクティブで1プロンプト実行して結果を標準出力に印字して終了する |
| `--prompt <prompt>` | — | — | `--print` のエイリアス |
| `--print-timeout <duration>` | — | `5m0s` | print モードのタイムアウト |
| `--model <model>` | — | — | このセッションで使用するモデルを指定する |
| `--add-dir <path>` | — | `[]` | ワークスペースにディレクトリを追加する（繰り返し指定可） |
| `--sandbox` | — | — | ターミナル制限付きサンドボックスで実行する |
| `--dangerously-skip-permissions` | — | — | すべてのツール実行許可リクエストを自動承認する（確認なし） |
| `--log-file <path>` | — | — | CLIログファイルのパスを上書きする |

## セッション再開の注意事項

- `--conversation` はセッション**ID**による指定のみ。`/rename` でつけたセッション名による指定はできない。
- 名前からIDを逆引きする機能はCLIには存在しない（2026-06-11時点）。

## サブコマンド一覧

| サブコマンド | 説明 |
| :--- | :--- |
| `changelog` | 変更履歴・リリースノートを表示する |
| `help` | サブコマンドのヘルプを表示する |
| `install` | 環境パスとシェル設定を構成する |
| `models` | 利用可能なモデル一覧を表示する |
| `plugin` / `plugins` | プラグインを管理する（install, uninstall, list, enable, disable） |
| `update` | CLIを最新版に更新する |
