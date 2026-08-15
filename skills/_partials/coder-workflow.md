## ゴール

PRを作成した時点で実装作業は完了する。CI監視はorchestratorの責務であり、コーダーは行わない。実装完了後の報告は不要（orchestratorがPRを自律検出する）。

**計画報告は実装着手前に必須である。** 計画をIssueのpin済みコメントとして投稿し、`msg-send.js`でorchestratorに報告すること。この報告を送った時点で1アクション完了とみなし、プロセスを終了してよい（承認または差し戻しの指示が届き次第、orchestratorから再開される）。

## 起動時に与えられる情報

- `WORKER_NAME=<name>` — このワーカーの識別名（worktree名。msg-poll.js/msg-send.js等の一意識別に使う）
- `WORKER_ROLE=<skill-name>` — このワーカーの役職（例: gh-maestro-investigator）
- `REPO=<owner/repo>` — 対象リポジトリ
- `WORKSPACE=<path>` — メインワークスペースのルートパス
- `WORKTREE=<path>` — あなた専用のgit worktreeパス（作業はここで行う）
- `ISSUE=<N>` — 担当するIssue番号
- `BASE_BRANCH=<branch>` — PRのベースブランチ

## 手順

{{RULES_CHECK_STEP}}
1. `gh issue view $ISSUE` でIssueの要件を把握する
2. **質問事項がある場合は通信ルールのコマンドでorchestratorに質問し、返答を待ってから作業を進める**
3. **計画フェーズ（実装着手前に必須）**:
   - `$WORKTREE` 上で実装計画に必要な調査（対象ファイル・変更方針・作業分割・検証条件）を行う
   - 実装計画をMarkdownファイルとして作成する
   - `publish-plan.js` で計画をIssueのpin済みコメントとして投稿する：
     ```sh
     node "{{SCRIPTS_PATH}}/publish-plan.js" --issue $ISSUE --body-file <計画ファイル> --workspace $WORKSPACE
     ```
     スクリプトが自動的に新規投稿（初回）か既存pinコメントの更新（差し戻し後）かを判定するため、コーダー側で分岐する必要はない
   - 通信ルールの `msg-send.js` で計画投稿完了を報告する。**報告本文には pin 済みコメントのURLだけを書く。計画の要約・概要・要点を本文に含めてはならない。** orchestrator が本文を読まずに要約で承認判断を下す経路を作らないためであり、architect が設計コメントのURLだけを通知するのと同じ流儀である（既存の「結果を返信する」規約の一種として位置づける）。この報告を送った時点で1アクション完了とみなし、**そのまま終了してよい**（既存のresume機構により、承認または差し戻しの指示が届いた時点でorchestratorから再開される）
   - **承認の指示を受け取ったら**、以下の手順4に進む
   - **差し戻し（修正依頼）の指示を受け取ったら**、計画を修正し、再度 `publish-plan.js` で同じpin済みコメントを更新し、再度報告して待機する
4. `$WORKTREE` 上で実装を完了させる（作業は必ず `$WORKTREE` 内で行う）
5. **新規追加・修正したファイルに対応するテストケースを作成し、`npm test` で全passすることを確認する**
   - **失敗側・拒否側の経路を必ずテストする。** 検証・ガード・エラー分岐を追加したなら、「正しく通ること」だけでなく「**正しく拒否されること**」を検証するテストを書く。ロックが取れないとき、ファイルが読めないとき、外部コマンドが失敗したとき、必須の引数が無いとき——それぞれで処理が期待どおり中断し、危険な操作が実行されないことを固定する
   - 成功側だけを検証したテストは、フェイルクローズが実際に閉じることを保証しない。「テストは緑だが、守るべき性質は守られていない」状態を作る
6. `git commit`/`git push` のフックは `.claude/rules/` や AGENTS.md の同期のみを実行する（テストは実行しない）。フックが失敗したら`--no-verify`等でバイパスせず、原因を修正してから再度commit/pushする
   - テスト失敗時のマージ防止は、PR 作成時に `gh-create-pr.js` が `npm test` の `# fail` が 0 であることを確認（0 でなければ PR を作成しない）し、さらにマージを CI テスト check の通過必須（ブランチ保護）で GitHub 側から機械的に制約する（Issue #209）
7. `gh-create-pr.js` でPRを作成する：
   ```sh
   node "{{SCRIPTS_PATH}}/gh-create-pr.js" --title "<PRタイトル>" --body "Closes #$ISSUE"
   ```
   baseブランチはワーカー起動時に与えられた `BASE_BRANCH` が環境変数として自動注入され解決されるため、明示的に指定する必要はない（`--base` フラグは受け付けない。未設定ならPR作成は明確に失敗する）

## 失敗時

```sh
gh issue edit $ISSUE --add-label "human-escalation"
node "{{SCRIPTS_PATH}}/msg-send.js" --stdin <<'EOF'
実装に失敗しました。human-escalation ラベルを付与しました。
EOF
```

## 制約

- `main` への直接pushは禁止
- `$WORKTREE` ルートで `npm install` / `npm ci` は実行しない。ルートの `node_modules` はシステムがjunctionで自動リンク済みのため、ルートで npm install を実行するとワークスペース共有の `node_modules` を破壊する
- 実装で新しいサブパッケージ（例: `gui/`）を追加した場合、そのディレクトリ内での `npm install` は許可する（`cd gui && npm install`）
- 判断に迷ったら通信ルールのコマンドでorchestratorに相談し、自分で止まらない
