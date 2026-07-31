---
paths:
  - "scripts/process-lifecycle.js"
  - "scripts/msg-poll.js"
  - "scripts/poll-pr.js"
  - "scripts/poll-reviews.js"
  - "scripts/remove-worker.js"
  - "scripts/reset-session.js"
  - "scripts/start-review-manager.js"
  - "scripts/run-review-manager.js"
  - "scripts/inbox-supervisor.js"
  - "scripts/worker-exit-hook.js"
---

# プロセスライフサイクル管理スクリプトの落とし穴

- 外部由来のpid引数はshell/fs操作に使う前に `parseInt` + `Number.isFinite(pid) && pid > 0` で検証する
- Linuxのプロセス開始時刻はprocfsの`birthtime`でなく`mtime`を使う（`birthtime`は`1970-01-01`を返すことがある）
- `.gh-maestro/pids/` 等の1ファイル1レコードJSON stateを読むときは、`JSON.parse`結果が期待するオブジェクト型か検証してからプロパティアクセスする。レコード全体の型検証だけでなく、比較演算（`>`等）に使う個々のフィールド（カーソル用タイムスタンプ等）が期待する型（文字列等）であることも検証する。オブジェクト等の非期待型は`>`比較で常にfalseを返し、カーソルが黙って固着する（PR #100 Review Manager指摘）
- detachした子プロセスを起動する場合、lock/registryのPIDは子プロセス自身が起動直後に自PIDで上書きする（launcherのPIDのまま生死判定しない）
- `process-lifecycle.js`の`registerProcess`をワーカー起因のプロセスから呼ぶ場合は必ず`workerName`を渡す（`remove-worker.js`のターゲット削除に必要）
- lock/temp等のリソースを作成する処理は、生成箇所すべてを`try/finally`または対応するエラーハンドラ（`child.on('error')`/`('exit')`等）でカバーする。一部だけ（例: lockFileのみ）をカバーし他（briefFile等）を見落とすと、異常系でファイルが残留する（PR #84 Review Manager指摘）
- レジストリのPIDが生きている（`isProcessAlive`）ことだけで「重複プロセスあり」と判定しない。プロセスがクラッシュしてレジストリエントリが残った後にOSがそのPIDを別プロセスへ再利用すると、無関係なプロセスを重複と誤検知し続ける。`verifyProcessIdentity`（`startTime`照合）で本当に同一プロセスかを確認してから重複と判定する（PR #90 Review Manager指摘）
- 「重複起動チェック→レジストリ登録」のような check-then-register 処理は、2段階が非アトミックだとTOCTOU競合（ほぼ同時に2プロセスが起動し両方がチェックを通過してしまう）を起こす。チェックと登録は単一のアトミックな主張操作（排他ロックファイルの取得等）にまとめる（PR #90 Review Manager指摘）
- 内部でリトライしながら指定時間内の終了を保証する有界待機（`--wait`等）で、サブ処理（`gh`呼び出し等）が独自の固定タイムアウトを持つ場合、締切直前に始まったサブ処理がその分だけ全体の締切を超過しうる。サブ処理のタイムアウトは残り予算に合わせて動的に絞り込む（PR #98 Review Manager指摘）
- GitHub APIの`since`パラメータ等、タイムスタンプ境界によるカーソル方式を使うポーリングは、境界がinclusive/exclusiveのどちらかをAPI仕様で確認せず前提にしない。同一タイムスタンプの複数レコードが存在すると境界の解釈次第で取りこぼしうる。タイムスタンプ単独でなく、処理済みIDの記録と併用して重複排除する（PR #100 Review Manager指摘）
- 多重起動防止・ロックを持つCLIスクリプトは、`require()`してmain()を直接呼ぶユニットテストだけでなく、実プロセス起動を伴う統合テストで検証する。`require.main === module`以下の分岐（`--force`バイパス・既存ロックでの多重起動拒否等）はユニットテストでは経路に入らず見落とされる（PR #139 Review Manager指摘）
- launcher（`inbox-supervisor.js`等）がonExitフック（`worker-exit-hook.js`）へ渡す引数に、共通ランチャー（`agent-exec.js`等）が末尾へ実際の終了コードを追加する場合、hook側の分割代入は固定位置ではなく末尾からの相対位置で解釈する。この種の変更を検証するテストは、手組みのargv配列を直接渡すのではなく、実際のランチャー関数（`buildLoginShellExecArgs`等）経由で構築した引数で行う。手組み配列は誤った前提の引数順序をそのまま再現し不整合を検出できない（PR #195 Review Manager指摘）
- ローカルの`new Date().toISOString()`（ミリ秒精度）とGitHub APIの`createdAt`等（秒精度）を文字列比較する場合、精度差により同一秒内のイベントが誤って「前」と判定されうる。異なるソースのタイムスタンプを比較する前に精度を揃える（PR #195 Review Manager指摘）
- `agent-defaults.json`のスキーマ変更（`resolve-config.js`側のロジック変更を伴う変更）に限らず、**`inbox-supervisor.js`・`poll-pr.js`・`poll-reviews.js`・`msg-poll.js`等の常駐プロセスは、`node scripts/install.js`でファイルを更新しても、既に起動中のプロセスは再起動するまで新しいコードを一切認識しない**（Node.jsはファイル変更を実行中プロセスへホットリロードしない）。スクリプト内容を変更するPRをマージ・installした後は、対象の常駐プロセスを`taskkill /PID <pid> /F`（Windows）等で停止し、再起動すること。`process-lifecycle.js sweep`は生存中の正当なプロセスも無差別にkillしうるため、この目的では使わない（対象PIDを`.gh-maestro/pids/*.json`から`script`名で個別に特定してkillする）。実障害: `inbox-supervisor.js`(pid 12812)が`node scripts/install.js`実行後もコード変更を認識せず、再起動まで`extends`未対応の古い解決ロジックのまま`agent-defaults.json`を読み、`resolveAgentConfig()`が`null`を返し続けて配送が数時間滞留した（Issue #173）
