# 実装計画: レビュアーを GitHub Actions から「ローカル直接 spawn + claude(DeepSeek)」へ移行

## Context（なぜやるか）

現状のレビュー CI は GitHub Actions 上で gh-aw がコンパイルした `reviewer.lock.yml` を実行し、**毎ラン Claude Code をまっさらな VM にインストールしてから** `reviewer.md` を DeepSeek で走らせている。このコールドスタートが**遅いときは10分以上**かかり、開発ループのクリティカルパス上で生産性を著しく損なう。

レビューの頭脳（`reviewer.md` の3観点ルーブリック + Claude Code + DeepSeek-flash）には不満がなく、**質を落とすことは絶対禁止**。問題は「どこで動かすか」だけ。

解決策: GitHub Actions / gh-aw をやめ、**claude が導入済みのローカルマシン上で `poll-pr.js` が `run-review.js` を直接 detached spawn する**。

## 検証で判明した実態（計画の前提を実装前に確定）

| 項目 | 実態 | 設計への反映 |
|---|---|---|
| `claude` | 導入済み。`-p/--print`・`--append-system-prompt-file`・`--model` あり | headless 起動可 |
| `claude-ds` | **実行ファイルでなく bash エイリアス**（`docs/deepseek/.bashrc`）。env 群を設定して `claude` を呼ぶだけ | env を再現して `claude` を直接 spawn |
| DeepSeek キー | `~/.deepseek-api-key` に **GPG 暗号化**。**この PC には現状ファイルが無い** | 前提条件: ユーザーが作成（下記）。gpg-agent がパスフレーズをキャッシュするため毎回 pinentry は不要 |
| モデル | `reviewer.md` は `deepseek-v4-flash` | 質一致のため `ANTHROPIC_MODEL=deepseek-v4-flash` |
| `gh` | `jintrick` で認証済み | ローカルから PR レビュー投稿可 |
| 投稿 | `post-review.js` が `gh api .../pulls/N/reviews` | 再利用可 |

### 前提条件（ユーザー作業・1回のみ）
`~/.deepseek-api-key` が無いと DeepSeek 認証不可。`docs/deepseek/README.md` の手順で作成:
```bash
gpg -c -o ~/.deepseek-api-key   # APIキーを入力しパスフレーズで暗号化
```

## アーキテクチャ

```
[既存] orchestrator が Monitor で poll-pr.js を起動（PR検出）
          │ PR 発見
          ├─→ PR_DETECTED:<N> emit（orchestrator は従来通り）        ← 無変更
          └─→ run-review.js を detached spawn（ロックファイルで二重起動ガード）
                  gpg -d ~/.deepseek-api-key（gpg-agent キャッシュ済みなら pinentry なし）
                  claude -p を DeepSeek env で起動、cwd=workspace
                  reviewer プロンプト（3観点 verbatim）でレビュー → gh で PR に投稿
                  終了時にロックファイル削除

[既存] orchestrator が Monitor で poll-reviews.js（コメント検出→トリアージ）     ← 無変更
```

## 新規ファイル

### `scripts/run-review.js`
1. `git -C <workspace> fetch origin pull/<pr>/head`（`git show <sha>:<path> | cat -n` の行番号検証に必要）
2. `scripts/review-prompt.md` を読み `<PR番号>`・`<REPO>` を実値置換 → temp に書き出し
3. `gpg -d ~/.deepseek-api-key` でキーを取得
4. `claude --dangerously-skip-permissions -p --append-system-prompt-file <prompt> "<起動指示>"` を spawn。**env に DeepSeek 設定を注入**:
   - `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
   - `ANTHROPIC_API_KEY=<復号済みキー>`
   - `ANTHROPIC_MODEL=deepseek-v4-flash`（+ DEFAULT_*_MODEL / CLAUDE_CODE_SUBAGENT_MODEL を flash に）
5. 終了コード・出力をログへ。失敗はログのみ（orchestrator 無関係）
6. ロックファイル（`.gh-maestro/review-<pr>.running`）を削除

### `scripts/review-prompt.md`
**`workflows/reviewer.md` のボディ（3観点ルーブリック・手順・禁止事項）を verbatim 移植**。変更は gh-aw 固有の足回りのみ:
- `${{ github.event.pull_request.number }}` → `<PR番号>` プレースホルダ
- `{{#runtime-import shared/reviewer-output-policy.md}}` → 内容をインライン展開
- 投稿手段を safe-outputs → **gh CLI**:
  - インライン: `gh api repos/<REPO>/pulls/<PR>/comments`
  - 最終 review: `gh api repos/<REPO>/pulls/<PR>/reviews`
- bash 利用（`gh pr view/diff`・`git show ... | cat -n`・`wc -l`）は完全据え置き

## 変更ファイル

- **`scripts/poll-pr.js`**: PR 発見時、ロックファイル確認 → なければ `run-review.js` を detached spawn（~10行）
- **ドキュメント/ルール**: `workflows/SPEC.md` 全面書き直し、`.claude/rules/ci-workflow-triggers.md` 更新、`skills/gh-maestro-orchestrator/SKILL.md` の「CI 再デプロイ」節を更新

### `poll-pr.js` の spawn パターン

```js
const lockFile = path.join(workspace, `.gh-maestro/review-${pr}.running`);
if (fs.existsSync(lockFile)) return;
fs.writeFileSync(lockFile, String(process.pid));

const child = spawn('node', ['scripts/run-review.js', pr, repo, workspace], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
});
child.unref();
```

## 退役（ローカル経路の動作確認後に一括）
`workflows/reviewer.md`・`reviewer.lock.yml`・`.github/workflows/reviewer.lock.yml`・`scripts/setup-ai-review.js`・`gh aw compile` 手順・`shared/reviewer-output-policy.md`（インライン化済）。移行期間は CI を残し、二重レビュー回避のため一括削除。

## smoke test（残る不確実性）
1. **DeepSeek 認証**: `ANTHROPIC_BASE_URL/API_KEY/MODEL=flash` を env に入れた `claude -p "say ok"` が DeepSeek で応答するか
2. **gpg-agent キャッシュ**: `gpg -d` を2回実行し、2回目が pinentry なしで返るか。detached 子プロセスからでもソケット経由で復号できるか
3. **claude -p の投稿**: print モードの claude が reviewer プロンプトに従い gh で PR に投稿しきれるか

## 検証
`node scripts/run-review.js <pr> <repo> <workspace>` を直接実行 → PR にレビュー出現、`.gh-maestro/review-<pr>.log` でトレース。
