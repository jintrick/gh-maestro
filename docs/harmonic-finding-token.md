# 実装計画: レビュアーを GitHub Actions から「ローカル常駐 HTTP サーバー + claude(DeepSeek)」へ移行

## Context（なぜやるか）

現状のレビュー CI は GitHub Actions 上で gh-aw がコンパイルした `reviewer.lock.yml` を実行し、**毎ラン Claude Code をまっさらな VM にインストールしてから** `reviewer.md` を DeepSeek で走らせている。このコールドスタートが**遅いときは10分以上**かかり、開発ループのクリティカルパス上で生産性を著しく損なう。

レビューの頭脳（`reviewer.md` の3観点ルーブリック + Claude Code + DeepSeek-flash）には不満がなく、**質を落とすことは絶対禁止**。問題は「どこで動かすか」だけ。

解決策: GitHub Actions / gh-aw をやめ、**claude が導入済みのローカルマシン上で、常駐 HTTP サーバーが reviewer プロンプトを起動する**。install が常駐ホストで1回きりになるため10分のコールドスタートが消滅し、プロンプト・モデルは無変更なので質は不変。トリガーは既存 `poll-pr.js` からの localhost POST（inbound 公開ゼロ）。

## 検証で判明した実態（計画の前提を実装前に確定）

| 項目 | 実態 | 設計への反映 |
|---|---|---|
| `claude` | 導入済み。`-p/--print`・`--append-system-prompt-file`・`--model` あり | headless 起動可 |
| `claude-ds` | **実行ファイルでなく bash エイリアス**（`docs/deepseek/.bashrc`）。env 群を設定して `claude` を呼ぶだけ | **サーバーは claude-ds を呼ばず、env を再現して `claude` を直接 spawn** |
| DeepSeek キー | `~/.deepseek-api-key` に **GPG 暗号化**。**この PC には現状ファイルが無い** | 前提条件: ユーザーが作成（下記）。サーバーが起動時に1回復号しメモリ保持 |
| モデル | `reviewer.md` は `deepseek-v4-flash` | 質一致のため `ANTHROPIC_MODEL=deepseek-v4-flash` |
| `gh` | `jintrick` で認証済み | ローカルから PR レビュー投稿可 |
| セッション起動 | `/gh-maestro` 入力時の **UserPromptExpansion フック**（`^gh-maestro$`, `~/.claude/settings.json`） | ここに4つ目としてサーバー detached 起動を追加 |
| 投稿 | `post-review.js` が `gh api .../pulls/N/reviews` | 再利用可 |

### 前提条件（ユーザー作業・1回のみ）
`~/.deepseek-api-key` が無いと DeepSeek 認証不可。`docs/deepseek/README.md` の手順で作成:
```bash
gpg -c -o ~/.deepseek-api-key   # APIキーを入力しパスフレーズで暗号化
```

## アーキテクチャ

```
[既存] /gh-maestro 入力 → UserPromptExpansion フック（setup/reset/get-context）
          └─→【新規・4つ目のフック】review-server.js を detached 起動（冪等）
                    起動時に gpg -d ~/.deepseek-api-key を1回（pinentry が1回だけプロンプト）
                    → 復号済みキーをプロセスメモリに保持

[既存] orchestrator が Monitor で poll-pr.js を起動（PR検出）
          │ PR 発見
          ├─→ PR_DETECTED:<N> emit（orchestrator は従来通り）        ← 無変更
          └─→【新規】http://127.0.0.1:<PORT>/review に {pr, repo, workspace} を POST

[新規] review-server.js（常駐）
          │ 202 即返し（fire-and-forget）
          └─→ run-review.js を spawn
                  claude -p を DeepSeek env（メモリ内キー + flash）で起動、cwd=workspace
                  reviewer プロンプト（3観点 verbatim）でレビュー → gh で PR に投稿

[既存] orchestrator が Monitor で poll-reviews.js（コメント検出→トリアージ）     ← 無変更
```

orchestrator から見ると GitHub Actions 時代と区別がつかない（コメントが湧く→トリアージ）。前回 reviewer をワーカー化して失敗した混乱は、常駐サービス化＋orchestrator 無改修により回避。

## 新規ファイル

### `scripts/review-server.js`（常駐 HTTP サーバー）
- 起動時に **`gpg -d ~/.deepseek-api-key` を1回**実行 → 復号失敗（鍵なし/パスフレーズ誤り）なら**fail loud でログに残し review 機能を無効化**。成功なら平文キーをメモリ保持
- `127.0.0.1:<PORT>`（ループバックのみ）で待受
- `POST /review` `{pr, repo, workspace}` → **202 即返し**、`run-review.js` を spawn
- 同一 PR の二重起動ガード（実行中 PR 番号セット。レビューは初回のみ＝現行 CI の opened/reopened 相当）
- `GET /health`（フックの冪等起動判定に使用）
- ログ: `<workspace>/.gh-maestro/review-<pr>.log`

### `scripts/run-review.js`（レビュー1回ぶん）
1. `git -C <workspace> fetch origin pull/<pr>/head`（`git show <sha>:<path> | cat -n` の行番号検証に必要）
2. `scripts/review-prompt.md` を読み `<PR番号>`・`<REPO>` を実値置換 → temp に書き出し
3. `claude --dangerously-skip-permissions -p --append-system-prompt-file <prompt> "<起動指示>"` を spawn。**env に DeepSeek 設定を注入**（`.bashrc` の claude-ds-flash 相当）:
   - `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
   - `ANTHROPIC_API_KEY=<メモリ内の復号済みキー>`
   - `ANTHROPIC_MODEL=deepseek-v4-flash`（+ DEFAULT_*_MODEL / CLAUDE_CODE_SUBAGENT_MODEL を flash に）
4. 終了コード・出力をログへ。失敗はログのみ（orchestrator 無関係）

### `scripts/review-prompt.md`（ローカル版プロンプト）
**`workflows/reviewer.md` のボディ（3観点ルーブリック・手順・禁止事項）を verbatim 移植**。judgment は一字一句変えない。変更は gh-aw 固有の足回りのみ:
- `${{ github.event.pull_request.number }}` → 注入する `<PR番号>` プレースホルダ
- `{{#runtime-import shared/reviewer-output-policy.md}}` → 内容をインライン展開
- 投稿手段を safe-outputs → **gh CLI**（mechanical 置換、判断には不影響）:
  - インライン: `gh api repos/<REPO>/pulls/<PR>/comments`
  - 最終 review: `gh api repos/<REPO>/pulls/<PR>/reviews`（既存 `post-review.js` と同一エンドポイント）
- bash 利用（`gh pr view/diff`・`git show ... | cat -n`・`wc -l`）は完全据え置き

## 変更ファイル

- **`scripts/poll-pr.js`**: PR 発見時、`PR_DETECTED:<pr>` emit 直前に `http://127.0.0.1:<PORT>/review` へ best-effort POST（~5行）。サーバー不在でも PR 検出は壊さない
- **`scripts/install.js`**: `^gh-maestro$` の UserPromptExpansion フック配列に4つ目を追加 → `start-review-server.js`（review-server を detached 起動する小ランチャ。`/health` で冪等化）。PORT は既定 + `~/.gh-maestro/config` 上書き可
- **ドキュメント/ルール**: `workflows/SPEC.md` 全面書き直し、`.claude/rules/ci-workflow-triggers.md` 更新、`skills/gh-maestro-orchestrator/SKILL.md` の「CI 再デプロイ」節を更新

## 退役（ローカル経路の動作確認後に一括）
`workflows/reviewer.md`・`reviewer.lock.yml`・`.github/workflows/reviewer.lock.yml`・`scripts/setup-ai-review.js`・`gh aw compile` 手順・`shared/reviewer-output-policy.md`（インライン化済）。移行期間は CI を残し、二重レビュー回避のため一括削除。

## 実装初手で必ず通す smoke test（残る不確実性）
1. **DeepSeek 認証の通し**: `~/.deepseek-api-key` 作成後、`ANTHROPIC_BASE_URL/API_KEY/MODEL=flash` を env に入れた `claude -p "say ok"` が DeepSeek で応答するか（鍵・モデル・エンドポイントの一括検証）
2. **pinentry 挙動**: detached でフック起動されたサーバーから `gpg -d` した時、Windows で pinentry GUI が1回ポップしユーザーが解錠できるか（tty/loopback 設定だと背景プロセスから解錠不可 → その場合は解錠 UX を別途設計）
3. **claude -p の投稿**: print モードの claude が reviewer プロンプトに従い gh で PR に投稿しきれるか

## 検証（E2E）
- 単体: サーバー起動 → 既知テスト PR に `curl -XPOST /review` → PR にレビュー出現、`.gh-maestro/review-<pr>.log` でトレース
- 質の同等性: 同一 PR を現行 CI レビューと突き合わせ（ルーブリック verbatim なので一致するはず）
- E2E: gh-maestro セッション → coder dispatch → PR 検出 → サーバー発火 → レビュー → トリアージ
- コールドスタート: レビュー開始まで「10分超→数秒」を実測

## 確定済み設計判断
- DeepSeek 認証: **セッション開始時に1回復号→サーバーがメモリ保持**（ユーザー選択）
- 起動: **`/gh-maestro` フックに detached 起動を追加**（冪等）
- 投稿: **claude がエージェント的に gh で投稿**（現行挙動に最も近く質の前提を保つ）
- 退役: **段階的**（ローカル検証後に CI 一括削除）
