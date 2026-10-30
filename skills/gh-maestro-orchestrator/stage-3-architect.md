---
signals:
  - script:spawn-worker.js:architect-start
---
# 工程 3. Architect起動判断【必須】

このファイルは、同じIssueを担当するorchestratorが工程3で実行する手順の正本である。工程番号・必須／任意・入口／待機／遷移を確認して進める。人間への発言と工程横断の不変条件はSKILL.mdに従う。

<!-- gh-maestro-structure: middle-items=1 -->

入口: 工程2の調査と既存判断照合が済んだとき。待つもの: architectを起動するか、時機・論点をどうするかについて必要な人間の判断。次: 起動する場合は3-[1/1]、起動しない場合は工程4。

Architectの起動判断自体は必須である。起動時機と相談内容について人間の判断を求める発言は「人間への発言の規範」に従う。`gh-maestro-architect` は任意の相談役であり、**起動しないのが既定**である。規模や新規性だけを理由に必須起動してはならない。起動契機は「3-[1/1] 抽象設計の検討」（実装前）と「5. 計画評価」での計画レビューの2つで、いずれも必須ゲートではない。

修正箇所と既存パターンが明確な局所変更、調査結果をIssue本文へ統合すればcoderが実装できる変更、実装手順の詳細化だけが目的の場合は起動しない。逆に、誤った構造判断の手戻りが大きい・責務境界の判断が要る・複数の抽象方針にトレードオフがある、といった場面に至ったら `{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/architect.md` を開き、起動可否の判断基準・起動手順・運用規約（設計コメントの扱い、`--execution-id`、Issueクローズまで削除しない等）はそこに従う。

作業の分割単位・PRの粒度・コミットの積み方・着手順序といった進め方は orchestrator 自身の責務である。architect はワーカーの作業手順に関する情報を持たないため、これらを相談してはならない。architect の設計コメントが進め方に言及していても、既決事項として Issue 本文に書き写さない。

#### 3-[1/1] 抽象設計の検討【任意】

入口: 工程3でarchitectへの相談を決めたとき。待つもの: 設計コメント。不足情報・要件矛盾があれば調査または人間確認も待つ。次: 解消後は工程4、事実不足なら工程2または人間確認へ戻る。

architect を起動した場合だけ、確定済み要件（Issue 本文）、相談したい設計上の論点、および参照先のポインタ（Issue コメント番号・ファイルパス）を入力として渡す。必要な事実は architect 自身がサブエージェント経由の調査で取得する。
理由と経緯: docs/adr/0038-architect-receives-questions-not-compressed-facts.md

不足情報・矛盾が返ったら、調査または人間確認へ戻る。手順は `{{SHARED_SKILLS_PATH}}/gh-maestro-orchestrator/architect.md` に従う。抽象設計のarchitectを起動するときだけ `spawn-worker.js` に `--guidance-signal architect-start` を付ける（計画レビューや他のworkerには付けない）。
