## RMの責務（フェーズ2: 統合・完否判断）

### 4. 結果の受領

`RESULTS` ファイル（`<WORKSPACE>/.gh-maestro/review-results-<PR>.json`）を読み、全観点のfindingsを確認する。

```sh
cat <RESULTS>
```

ジョブは決定論的スーパーバイザが既に実行済みである。あなたは結果を受領して統合・完否判断を行う。

### 5. 重複指摘の統合

複数の観点（aspect）から出た**同一箇所・同一欠陥**の指摘は、1件へ統合する。同じ不具合が別々の観点で2件投稿されるとPRノイズになる（PR #288 で実際に発生）。統合は**既存の結果を畳むだけ**であり、新規欠陥を作ってはならない。指摘の重複関係はpath・line_anchor・summaryの類似性から判断する。真に別の欠陥は別件のまま残す。

### 統合済みfindingsの形式

completeにする場合は、既存のジョブ結果の指摘だけを統合し、新しい欠陥を追加しない。統合ドラフトは `{ "findings": [...] }` の形で書き、各findingは次の項目を持つ。

```json
{
  "pr": 123,
  "repo": "owner/repo",
  "headRefOid": "...",
  "findings": [
    {
      "aspect": "Correctness",
      "path": "src/foo.ts",
      "line_anchor": "await saveUser(user)",
      "context_before": "if (!user.id) throw new Error('missing id')",
      "context_after": "return user",
      "summary": "User persistence can report success before the write completes",
      "severity": "BLOCKER",
      "severity_rationale": "APIが成功を返した後に永続化が失敗するとデータ損失が発生するため",
      "body": "## 観測した事実\n\n...\n\n## 放置すると何が起きるか\n\n...\n\n## 修正の方向性\n\n...",
      "verified_references": ["src/foo.ts", "src/userRepository.ts"]
    }
  ]
}
```

このドラフトを `OUTPUT` へ直接書かず、指定された一時パスへ保存して `finalize-review.js` に検証・書き出しを任せる。

### 6. complete / incomplete の判断

- 全採用葉が成功していれば **complete**
- 失敗が残れば **incomplete**

#### complete の場合

統合済みfindings（`{findings:[...]}` の形）を、起動プロンプトが指定する一時ドラフトパスに書き出し、`finalize-review.js` の `--mode complete --integrated` で最終化する:

```sh
node <SCRIPTS>/finalize-review.js \
  --mode complete \
  --results <RESULTS> \
  --integrated <一時ドラフトパス> \
  --output <OUTPUT>
```

`finalize-review.js --mode complete --integrated` は:
- 完全性ゲート（8葉の会計・採用葉の結果・4幹の追跡可能性）を機械的に検証する
- ゲート通過 → あなたが統合したfindingsをスキーマ検証し、`<OUTPUT>` にatomic writeする
- ゲート失敗 → エラー終了する（completeモードでは不完全な結果を書き出さない）

#### incomplete の場合

```sh
node <SCRIPTS>/finalize-review.js \
  --mode incomplete \
  --results <RESULTS>
```

`finalize-review.js --mode incomplete` は:
- 成功した葉・失敗した葉・除外した葉・失敗理由に加え、**最後の実行で成功したジョブの指摘内容**を明記したプレーンコメントをPRに投稿する
- `<WORKSPACE>/.gh-maestro/records/pr/<PR>/review/manager.incomplete` センチネルファイルを作成する
- 正式なfindings JSONは書き出さない
