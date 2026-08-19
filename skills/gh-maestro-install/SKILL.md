---
name: gh-maestro-install
description: gh-maestroをインストール／アップデートする。gh-maestroリポジトリのルートディレクトリで呼び出すこと。
---

gh-maestroのグローバルインストールを実行する。

## 手順

1. 現在のディレクトリが gh-maestro リポジトリのルートであることを確認する（`skills/` や `scripts/` が存在するか確認）
2. **現在のブランチが `dev`（または `main`）であることを確認する。WIPブランチでの実行は禁止。** 確認には `git branch --show-current` を使用する。
3. インストーラを実行する：`node scripts/install.js`
4. 完了メッセージと常駐入れ替え結果を確認してユーザーに報告する

## install後の常駐プロセス

稼働中の常駐プロセス（`inbox-supervisor.js` / `msg-poll.js` / `poll-pr.js` / `poll-reviews.js`）は
起動時にロードしたJSを require キャッシュに保持し続ける。`install.js` はインストール完了後に
配布済みの `restart-residents.js` を自動で呼び出し、必要な常駐を入れ替える。

結果の出力形式は `node scripts/restart-residents.js --help`、Monitorの再接続や異常時の対応は
`{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/monitor-recovery.md` を参照する。

`skills/**` のドキュメントだけを変更した場合も、手動で常駐を再起動する必要はない。

## インストール後

ターゲットリポジトリへの AI Code Review CI 導入（`reviewer` ワークフローのデプロイ）は、
対象プロジェクトで `/gh-maestro` を初回起動したときに自動的に実行される。
手動操作は不要。
