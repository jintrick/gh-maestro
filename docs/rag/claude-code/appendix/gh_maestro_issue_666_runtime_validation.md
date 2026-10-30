# Issue #666: Claude Code 実機確認記録

確認日: 2026-10-31  
対象: Claude Code 2.1.314 / Windows interactive CLI

Issue #666 の実装前ゲートとして、イベント通知・hook の追加文脈・手順書の解決先を確認した。実機 hook、monitor、settings は一時ディレクトリのプロジェクト配下だけに置いた。通常のログインを使い、`CLAUDE_CONFIG_DIR` は変更していない。確認用セッションは終了時に monitor を停止した。

## 1. monitor 通知の入力形式

orchestrator セッションでの観測結果を記録する。monitor の stdout 通知は `<task-notification>` の中に `<task-id>`、`<summary>`、`<event>...</event>` を含む。`<event>` には stdout の行がそのまま入り、例として `PR_DETECTED:665` と `NEW_MESSAGE:666:6534110956` が確認された。

## 2. 複数行通知の合流

orchestrator セッションでの観測結果を記録する。複数の monitor stdout 行は1つの通知の `<event>` 内に改行区切りで合流した。PR #665 では `SLOW_TEST_STARTED:{...}`、`CI_CHECKS_EMPTY:{...}`、`TEST_STATUS:...`、`PR_COMMENT:...` が同じ `<event>` に入っていた。

## 3. 事実ブロックを additionalContext で渡す

一時プロジェクトの `.claude/settings.json` に `UserPromptSubmit` command hook を設定し、実際の Claude Code interactive セッションで `FACT_CONTEXT_PROBE` を含むpromptを送った。hook は `hookSpecificOutput.hookEventName: "UserPromptSubmit"` と `additionalContext` を JSON で返し、実ファイルの冒頭を「このファイルの現在の内容」とする事実ブロックで包んだ。

モデルは追加文脈に含まれた見出し `# 反省会の実施手順（参照専用）` を正確に返した。hook の入力ログにも対象prompt、解決したファイル、送った抜粋が記録された。したがって、この形の `additionalContext` は次のモデル要求で利用できた。

## 4. hook が読む手順書の解決先

対象worktreeの `.claude/skills/gh-maestro-orchestrator` は存在せず、ユーザー領域の Claude スキルコピー `C:\Users\Jintrick\.claude\skills\gh-maestro-orchestrator` は存在した。hook はプロジェクトローカルを確認した後に `user-install` へフォールバックし、`C:\Users\Jintrick\.claude\skills\gh-maestro-orchestrator\retrospective.md` を実際に読み込んだ。ログの解決先は、このworktreeで使われるClaudeスキルのインストール済みコピーと一致した。

Claude Code ローカルRAGの構成ディレクトリ資料では、プロジェクト内の `.claude/skills/` とユーザー領域の `~/.claude/skills/` が有効なスキル置き場として定義されている。今回のworktreeには対象スキルのプロジェクトローカルコピーが無いため、インストール済みコピーを使う解決は実環境と一致した。

## 実機構成と後始末

- monitor plugin と `.claude/settings.json` は `%LOCALAPPDATA%\Temp\gh-maestro-issue666-real-check-*\project` 配下に作成した。
- セッションは `--setting-sources project,local --permission-mode plan` で起動した。
- ファイル編集系ツールをdenyした状態で確認し、対象worktreeやIssue/PRへ書き込みをしていない。
- セッション終了時に `Exit and stop tasks` を選び、monitorを停止した。
- 初回の試験用hookはログ出力先の環境変数が未設定だったため有効な確認結果として扱わず、パスを明示したhookで項目3・4を再確認した。

## Issue #666 実装後の配信確認

確認日: 2026-10-31  
対象: Claude Code 2.1.314 / Windows interactive CLI

通常ログインを使い、`CLAUDE_CONFIG_DIR` は変更せず、確認用 `.claude/settings.json` と `UserPromptSubmit` hook、`.gh-maestro` runtime、現在の orchestrator スキル一式を一時プロジェクト配下だけに置いた。作業worktreeへ戻らず、一時プロジェクトをカレントディレクトリにしてセッションを起動した。セッションIDを一時runtimeに記録し、確認後 `/exit` で終了した。ユーザー領域の設定ファイル、GitHub Issue/PR、worktreeへの書き込みは行っていない。

実際の Claude Code セッションへ通知形式のpromptを入力し、`UserPromptSubmit` hook が `additionalContext` で返した手順書の見出しをモデルに回答させた。

- `PLAN_REPORTED:666:123` で `stage-5-plan-review.md` が届き、モデルが `5-[1/3] 計画の評価【必須】` を回答した。
- 1つの `<event>` に改行区切りの `PR_DETECTED:666` と `PR_PUSH:abc123` を入れると `stage-7-review-merge.md` が届き、モデルが工程7の見出しを回答した。
- `PR_COMMENT:666:123` で `triage.md` が届き、モデルがトリアージ手順の見出しを回答した。
- `PR_MERGED:666` で `stage-8-deployment-check.md`、`stage-9-retrospective.md`、`retrospective.md` の3文書が同じ `additionalContext` に含まれ、モデルは3つの見出しを回答した。現在の宣言とhookのレンダリング関数で確認した束の長さは5,337文字（UTF-8 11,033 bytes）で、9,000文字上限以内だった。

通知イベント自体は一時セッションへの手入力で再現した。plugin monitorは起動していないため、monitorからClaude Codeへの実配送は本確認の対象外である。通知名から文書を選び、Claude Codeの次の要求文脈に配信するhook経路は実機で確認できた。
