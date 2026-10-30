---
signals:
  - script:msg-send.js:approval
---
# 工程 6. 実装開始指示【必須】

このファイルは、同じIssueを担当するorchestratorが工程6で実行する手順の正本である。工程番号・必須／任意・入口／待機／遷移を確認して進める。人間への発言と工程横断の不変条件はSKILL.mdに従う。

<!-- gh-maestro-structure: middle-items=1 -->

入口: 工程5で人間が承認または修正を決めたとき、または修正版計画が5-[3/3]の条件を満たしたとき。待つもの: 承認時はコーダーがPRを作成すること、差し戻し時は修正版計画。次: 承認後のPR_DETECTEDで工程7、修正版計画で工程5。

#### 6-[1/1] 人間の判断をコーダーへ伝える【必須】

「人間への発言の規範」に従って受けた人間の判断をもとに、承認と差し戻しのどちらか一方だけを実行する。両方が通ることはない。

- **承認**: 承認する計画が約束した振る舞い・確認を Issue 本文の受け入れ条件と照合する。受け入れ条件にない要件があれば、`gh issue view <N> --repo $REPO --json body --jq .body` で GitHub 上の現在の Issue 本文を取得し、その本文全体を元に受け入れ条件を追記した更新本文を作って `update-issue.js` で更新する。起票時の下書きなど手元のファイルを元の本文として使わない。実装方針・作業分割・具体的なテスト手順などの実装詳細は追記せず、受け入れ条件を要件として記述する。更新後、または追加事項がないと確認した後に、`msg-send.js` でコーダーに承認を伝え、実装着手を指示する。
  コーダー／シニアコーダーの場合、承認指示を送る**前に** `set-response-contract.js` で応答契約を設定すること。
  これにより、実装完了後に `msg-send.js` が呼ばれなくても PR 作成をもって完了とみなされ、
  誤った自動代理送信が発生しなくなる。
  ```sh
  # 1. 応答契約を設定（コーダー／シニアコーダーの計画承認時のみ必須）
  node "{{SCRIPTS_PATH}}/set-response-contract.js" \
    --issue <N> --skill <gh-maestro-coder または gh-maestro-senior-coder> \
    --type artifact-or-message --artifact pr --workspace $WORKSPACE

  # 2. 承認指示を送信
  node "{{SCRIPTS_PATH}}/msg-send.js" --issue <N> --skill <gh-maestro-coder または gh-maestro-senior-coder> --workspace $WORKSPACE --guidance-signal approval --stdin <<'EOF'
  計画が承認されました。計画に従って実装を開始してください。
  EOF
  ```

- **差し戻し（修正依頼）**: 差し戻しには2種類ある。実装のやり方だけを変えるものと、要件そのものを変えるものである。

  要件を変える場合は、`gh issue view <N> --repo $REPO --json body --jq .body` で GitHub 上の現在の Issue 本文を取得し、その本文全体を元に受け入れ条件を新しい要件へ揃えた更新本文を作ってから `update-issue.js` で更新し、続けて `msg-send.js` で修正指示を送る。この2つを同じ差し戻しの操作として扱う。起票時の下書きなど手元のファイルを元の本文として使わない。受け入れ条件が古いまま残ると、実装は新しい指示に従う一方でレビューは古い受け入れ条件と突き合わせるため、両者の食い違いが欠陥として報告される。

  実装のやり方だけを変える場合は、Issue 本文を触らない。

  ```sh
  # 要件を変える差し戻しのときだけ、先に受け入れ条件を更新する
  node "{{SCRIPTS_PATH}}/update-issue.js" --issue <N> --title "<タイトル>" \
    --body-file /tmp/issue-<N>.md --repo $REPO --workspace $WORKSPACE

  node "{{SCRIPTS_PATH}}/msg-send.js" --issue <N> --skill <gh-maestro-coder または gh-maestro-senior-coder> --workspace $WORKSPACE --stdin <<'EOF'
  計画に以下の修正が必要です。修正後、計画を更新して報告してください:
  - <具体的な修正点1>
  - <具体的な修正点2>
  EOF
  ```

  コーダーは計画を更新して再報告し、待機する。
