---
paths:
  - "tests/**"
  - "scripts/spawn-worker.js"
  - "scripts/reset-session.js"
  - "scripts/child-process.js"
  - "scripts/gh-maestro-setup.js"
  - ".githooks/**"
---

# テスト内での実プロセス spawn 禁止

**アーキテクチャ原則: detached な「常駐ポーラー」を作らない。** gh-maestro の通信基盤は GitHub Issue コメントベースに移行済み（`docs/github-comm-plan.md`）。ポーリングはすべて呼び出し元エージェントのターン内で blocking 実行される。

過去に `.gh-maestro` のプロセス群（poller / notifier）は detached な常駐プロセスを起動していた。単一のテストスイート実行で detached poller が **65 プロセス・CPU 100%** に達し、手動強制停止が必要になった事例がある。

**ワーカー本体プロセスはこの禁止の対象外である。** Issue #151 以降、ワーカーは `shared/headless-launch.js` により detached で起動される（起動元の使い捨てCLIが終了しても生き続ける必要があるため）。ただしこれは**一度きりの実行で自然終了する**プロセスであり、無限にポーリングし続ける常駐プロセスとは性質が異なる。区別の基準は「終わるかどうか」であって「detached かどうか」ではない。

- 実障害（Issue #151 Phase 2）: 引数バリデーションだけを検証するテストが、ガードの無い状態で worktree 作成とエージェント起動まで到達し、実際に `claude.exe` が **4本起動してトークンを消費**した。うち1本は stray worktree 内でテストスイートまで走り始めていた。`WEZTERM_PANE` 必須チェックが偶然の安全弁になっており、headless 化でそれが失われたことが原因。
- 対策として `launchAgentHeadless` は `NODE_TEST_CONTEXT`（`node --test` がテストファイルへ自動設定し、そこから spawn された子プロセスにも継承される）を検出したら実起動を拒否する。テスト側の設定漏れに依存せず効く。spawn を注入済みの場合のみ通す。

- **テストは poller / watcher / ワーカー / エージェントCLI を実起動しない。** spawn を env フラグでゲートするか、spawn 関数を注入してモックし、**テストは実プロセスを 0 個 spawn する**。
- **引数バリデーションだけを見たいテストは、副作用の手前で確実に停止させる。** 全引数を妥当な値で埋めると `spawn-worker.js` は worktree を作りエージェントを起動する。実在しない `--agent` を渡す等、検証の後・副作用の前で落ちる引数を選ぶこと。
- **ゲートするのは実 spawn であって、テストではない。** env フラグ/注入で抑止するのは実プロセスの spawn。テスト本体は既定スイート（`npm test`）で必ず実行する。テストごと env でスキップするとその回帰カバレッジが静かに消える。実 spawn 回避と既定実行の両立にはモック注入を優先。
- **`detached` + `unref` のプロセスはテストランナーをブロックも失敗もさせない。** `node --test` は緑で完走するため「全テスト pass」ではこの被害を検出できない。緑を安全の根拠にしない。
- **spawn しうるコードのテスト実行後は、孤児プロセスが 0 であることを確認する。** 例（Windows）: `powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -like '*node --test*' }).Count"` が 0（テストランナー自身が終了すれば孤児は残らない）。
- **自プロセス（`process.pid`）を registry に登録するテストは、`afterEach` 等で必ず `unregisterProcess` すること。** 残留すると後続テストの `sweepRegistry`/`killProcessTree` がテストランナー自身を対象にする事故につながる（PR #64 で実際に発生）。

## 実spawnした子プロセスへの環境変数リークと外部副作用ガード（Issue #202）

上記は「テストが常駐プロセスをspawnする」失敗モードだが、これとは別に「一度きりで終了する実spawn自体は許容されるが、その子プロセスが親のワーカー文脈環境変数（`GH_MAESTRO_WORKER`・`GH_MAESTRO_WORKSPACE`等）を継承し、その先で外部副作用API（GitHub投稿等）を呼んでしまう」という失敗モードがある。

- 実障害: `worker-exit-hook.test.js` の実spawn CLIテストが `env` 未指定だったため、ワーカープロセス自身が `npm test` を実行すると `GH_MAESTRO_WORKER`/`GH_MAESTRO_WORKSPACE` が子プロセスへ継承され、`msg-send.js` が実ワークスペース・実Issueを解決して本物のGitHub Issueへ偽の通知を投稿した。
- 対策は二層: (1) `tests/_spawn-env.js::cleanSpawnEnv()` で実spawn時にワーカー文脈envを除去する（テスト側の対策）。(2) `scripts/msg-send.js` に `NODE_TEST_CONTEXT`（`node --test` が自動設定し子プロセスにも継承される）を検出したら実投稿をフェイルクローズで拒否するガードを追加する（本番コード側の構造的対策。Issue #151 で `launchAgentHeadless` に導入したのと同じパターン）。
- (1)だけでは「envクリーンし忘れ」という将来のテスト側の注意力に依存する。**外部副作用（GitHub投稿・破壊的操作等）を持つ共有スクリプトを新設・変更する際は、(2)のようなNODE_TEST_CONTEXTガードを本体側に持たせることを検討する**（テスト側の設定漏れに依存せず効くため）。

## フック環境の git 変数がテストへ漏れ、実リポジトリを破壊する経路（Issue #283）

#202 が「子プロセスが親のワーカー文脈 env を継承する」失敗モードなのに対し、本件は「**git がフック環境へ注入した GIT_* 変数を node --test が子プロセスへ継承し、`GIT_DIR` が `spawnSync` の cwd 指定より優先されて git のリポジトリ発見を実リポジトリへ上書きする**」経路。

- 実障害: リンク付き worktree から push すると git が pre-push フック環境へ `GIT_DIR=<実リポジトリ>/.git/worktrees/<名前>` を設定する（core.hooksPath により worktree の `.githooks` が実行される）。`npm test`（node --test）がこれを全テストファイルと spawn 子プロセスへ継承し、一時dirを cwd にしていても `worktreeAdd` / `superviseReviewManager` / `gh-maestro-setup.js` の git 操作が全て実リポジトリへ着弾する。既存テストは「**緑のまま**実リポジトリを壊す」ため、テスト失敗では検出されない。
- 対策:
  1. **フックでテストを走らせない。** フック経由の実行結果がコーダー自身の実行結果と一致する保証が無い以上、フックからのテスト実行は禁止する。`gh-maestro-setup.js` は checks フックを設置せず、設置済みのものは撤去する。
  2. `.githooks/pre-commit` の冒頭で**リポジトリ位置系の変数だけ**を unset する（GIT_DIR / GIT_COMMON_DIR / GIT_WORK_TREE / GIT_OBJECT_DIRECTORY / GIT_ALTERNATE_OBJECT_DIRECTORIES / GIT_QUARANTINE_PATH）。**`GIT_INDEX_FILE` と `GIT_PREFIX` は落としてはならない**——`git commit -a` やパス指定コミットでは git が一時インデックスを渡すため、落とすとステージ判定が空に見え、同期処理が無言でスキップされる。
  3. `tests/_env-setup.js` の `--require` プリロードで注入変数を除去（テスト環境の中和。手動 `npm test` も守られる）。
  4. `scripts/child-process.js` 共有ラッパーが **git を spawn するとき** リポジトリ位置系の変数を env から除去する（「cwd が正」を保証。テストはバイパス不要で既存テストが無改変のまま通る）。設定変数（GIT_CONFIG / GIT_CONFIG_PARAMETERS / GIT_CONFIG_COUNT）は位置と無関係なので除去しない。git 以外の spawn は従来どおり。
  - 外部副作用（GitHub API DELETE）: `gh-maestro-setup.js::retireAiReviewCi` に `NODE_TEST_CONTEXT` 検出時フェイルクローズガード。ローカル git 操作は上記3層で守られるためガード不要。
- 受け入れ条件は「ガードが throw すること」ではなく「**実リポジトリが無傷であること**」。`tests/env-leak-guard.test.js` が GIT_DIR 注入下で各操作を呼び、victim リポジトリのスナップショット（for-each-ref / HEAD / config / worktree list / `.git/worktrees/` 列挙）が操作前後で不変であることを検証する。
