# Review Manager JSON 修復計画書

策定日: 2026-07-04
ステータス: 計画
対象: `run-review-manager.js` / `review-publisher.js` / `gh-maestro-reviewer`

## 目的

Review Manager が生成する JSON を `review-publisher.js` の契約に厳密に合わせ、PR コメント投稿を deterministic に成功させる。

今回の障害では、Review Manager 本体はレビュー結果を生成できたが、出力 JSON が publisher の期待スキーマを満たさず、投稿で停止した。

```text
review-publisher: headRefOid is required
```

この種の失敗は今後も起こりうるため、壊れた JSON を緩く救済するのではなく、機械境界で厳密に弾き、Review Manager 自身に再生成させる流れへ変える。

## 現在の問題

現状の流れ:

```text
run-review-manager.js
  -> codex exec で Review Manager を起動
  -> Review Manager が output JSON を書く
  -> run-review-manager.js が review-publisher.js を呼ぶ
  -> publisher が strict validation
  -> 不正 JSON ならそのまま失敗終了
```

今回の実例では、出力ファイルに以下の問題があった。

- `headRefOid` がない
- `findings` が publisher 契約の finding 形式ではない
- `reviewers[].findings[]` は人間には読めるが、publisher が扱う `aspect` / `line_anchor` / `observed_fact` 形式ではない
- `requested_skill_available: false` かつ `mode: "manual-fallback"` だったが、publisher 呼び出し前に停止しなかった

結果として、レビュー本文は生成済みなのに GitHub 投稿だけ失敗した。

## 原因

根本原因は 2 つある。

1. deterministic に取得できる値を LLM 出力へ依存している

- `headRefOid` は `gh pr view --json headRefOid` で取得できる
- にもかかわらず、publisher の必須フィールドとして LLM 生成物に依存している

2. publisher 契約違反時の差し戻しループがない

- `review-publisher.js` は strict validation を行う
- これは正しい
- しかし `run-review-manager.js` が失敗を Review Manager に返さず、その場で終了している

## 方針

方針は単純で、壊れた JSON に対する投稿フォールバックは入れない。

```text
Review Manager が JSON を書く
  -> deterministic 補完
  -> strict validation
  -> 不正なら Review Manager へ差し戻し
  -> 正しい JSON が出たら publisher 実行
```

重要な原則:

- publisher は strict のまま維持する
- 不正 JSON を Markdown に変換して投稿しない
- deterministic に取れる値は LLM に書かせない
- LLM の責務は「スキーマに合う finding を返すこと」に限定する

## 修正項目

### 1. `headRefOid` を deterministic に補完する

`run-review-manager.js` で Review Manager 起動前、または起動後 publisher 実行前に `headRefOid` を取得する。

想定:

```text
gh pr view <PR> --repo <REPO> --json headRefOid
```

補完タイミング:

- 第1候補: Review Manager 起動前に取得し、プロンプトへ渡す
- 第2候補: Review Manager 出力後に JSON を読み、欠落していれば `run-review-manager.js` が注入する

優先は第1候補。ただし安全性のため、出力後注入も併用してよい。

### 2. Review Manager への入力契約を明文化する

`gh-maestro-reviewer` スキル、または `run-review-manager.js` が作る prompt に、publisher 契約をそのまま埋め込む。

最低限含める内容:

- payload の必須フィールド
- valid finding shape
- valid `aspect` 値
- `line_anchor` は実コード断片であること
- prose を混ぜず、`OUTPUT` に JSON だけを書くこと

「manual-fallback 形式でもよい」という曖昧さは消す。

### 3. `run-review-manager.js` に差し戻しループを入れる

`review-publisher.js` 失敗時に即終了せず、Review Manager に再実行を求める。

差し戻しメッセージの要件:

- publisher の失敗理由をそのまま渡す
- `OUTPUT` を上書き修正させる
- レビュー内容そのものは原則維持させる
- prose 追加禁止

例:

```text
The JSON at OUTPUT is invalid for review-publisher.js.
Publisher error:
headRefOid is required
finding[0].aspect is required
...

Rewrite OUTPUT so it satisfies the publisher schema exactly.
Do not add prose.
Do not change conclusions unless needed for schema compliance.
```

リトライ回数は無制限にしない。

- 推奨: 最大 2 回
- 2 回失敗したらログを残して終了

### 4. `review-publisher.js` のエラーを機械可読にする

差し戻しループのため、publisher の失敗理由は人間向け文面だけでなく、できるだけ機械可読に寄せる。

候補:

- 既存の `Error("headRefOid is required; ...")` を維持しつつ、複数エラーを安定順序で並べる
- 可能なら `--dry-run --json-errors` のような出力モードを追加する

初回実装では後者は不要。まずは安定したエラーメッセージで十分。

### 5. `manual-fallback` を publisher 前に止める

今回の JSON には以下が入っていた。

```json
"mode": "manual-fallback",
"requested_skill_available": false
```

これは「想定した Review Manager スキル経路で動いていない」ことを意味する。

この場合の扱いを決める。

- 厳格案: `manual-fallback` なら publisher を呼ばず失敗扱い
- 緩和案: `manual-fallback` でも strict schema を満たすなら続行

この計画では緩和案を採る。重要なのはスキル経路ではなく、出力契約が守られていることだからである。

ただしログには明示する。

## 実装ステップ

1. `run-review-manager.js` で `headRefOid` を取得する
2. Review Manager prompt に publisher 契約を明記する
3. `review-publisher.js --dry-run` を `run-review-manager.js` から先に呼び、検証だけ行う
4. dry-run が失敗したら、Review Manager に差し戻しプロンプトを送り再生成させる
5. dry-run 成功後のみ、本番の `review-publisher.js` を呼ぶ
6. 失敗ログを `review-manager-<PR>.log` に詳細出力する
7. 自動テストを追加する

## テスト計画

追加すべきテスト:

- `run-review-manager.js` が `headRefOid` を補完する
- `review-publisher.js --dry-run` が不正 payload を安定したエラーで弾く
- 1 回目の invalid JSON 後、差し戻しで valid JSON に直れば publish に進む
- 2 回連続で invalid JSON なら終了する
- `manual-fallback` でも strict schema を満たせば publish できる

既存テストの補強対象:

- [tests/review-publisher.test.js](C:/Users/amg/work/gh-maestro/tests/review-publisher.test.js:1)
- 新規で `tests/run-review-manager.test.js` を追加するのが自然

## 非目標

- 壊れた JSON を人間向け Markdown に変換して PR へ投稿する fallback
- publisher 側で曖昧な finding を推測補完すること
- `line` しかない finding から `line_anchor` を逆算すること
- strict validation を緩めること

## 完了条件

以下を満たしたら完了とする。

- `headRefOid` 欠落で投稿失敗しない
- invalid JSON は publisher 前に検出される
- invalid JSON は Review Manager に自動差し戻しされる
- valid JSON が再生成されたらそのまま PR 投稿まで完走する
- strict validation を維持したまま end-to-end が通る

## 判断

この問題は「publisher が厳しすぎる」のではなく、「publisher が厳密なのに、その前段が契約違反を許したまま流している」ことが原因である。

したがって直すべき箇所は publisher の緩和ではなく、`run-review-manager.js` の責務整理と Review Manager への差し戻し制御である。
