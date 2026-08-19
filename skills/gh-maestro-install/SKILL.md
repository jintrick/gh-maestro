---
name: gh-maestro-install
description: gh-maestroをインストール／アップデートする。gh-maestroリポジトリのルートディレクトリで呼び出すこと。
---

gh-maestroのグローバルインストールを実行する。

## 手順

1. 現在のディレクトリが gh-maestro リポジトリのルートであることを確認する（`skills/` や `scripts/` が存在するか確認）
2. **現在のブランチが `dev`（または `main`）であることを確認する。WIPブランチでの実行は禁止。** 確認には `git branch --show-current` を使用する。
3. インストーラを実行する：`node scripts/install.js`
4. 完了メッセージを確認してユーザーに報告する
5. 今回の install に `scripts/` または `skills/agents.yaml` の変更が含まれるなら、下記の常駐入れ替えコマンドを実行する

## `scripts/` を変更した install の後は常駐プロセスを入れ替える（必須）

稼働中の常駐プロセス（`inbox-supervisor.js` / `msg-poll.js` / `poll-pr.js` / `poll-reviews.js`）は
起動時にロードしたJSを require キャッシュに保持し続けるため、`install.js` を実行しても
新しいコードが届かない。そのまま作業を続けると「コードは直っているのに実システムでは
壊れたまま」の状態で進むことになる（Issue #280 で実害。丸一日気づかなかった）。

`scripts/` 配下または `skills/agents.yaml` に触れた場合は、人間にセッション再起動を依頼せず、
次の単一コマンドを実行する。変更ファイルが常駐4種の require 閉包に入るかは毎回判定しない
（判定コストの方が高い）。

```sh
node scripts/restart-residents.js --workspace $WORKSPACE
```

出力の `RESIDENT script=<name> status=replaced ... verified=true` はMonitorを持たない
`inbox-supervisor.js` の立て直し完了を表す。`monitor-required` はCLIがdetached起動せず
停止したMonitor常駐を、`MONITOR_REATTACH_REQUIRED` の各 `command=` でMonitorから張り直す
必要がある状態である。`delegated` は `poll-pr.js` が `poll-reviews.js` を子として引き継ぐ。
`not-running` は入れ替え対象が無かったこと、`failed` は未確認のため入れ替えを完了扱いにしては
いけないことを表す。特に `msg-poll.js` は出力先がorchestratorのMonitorなので、プロセスが
稼働していてもMonitorを張り直すまで通知は届かない。

**`skills/**` のドキュメントだけを変更した場合は常駐入れ替え不要。** 常駐プロセスは SKILL.md を
読まないため、陳腐化するのは変更したエージェント自身のコンテクストだけである。

## インストール後

ターゲットリポジトリへの AI Code Review CI 導入（`reviewer` ワークフローのデプロイ）は、
対象プロジェクトで `/gh-maestro` を初回起動したときに自動的に実行される。
手動操作は不要。
