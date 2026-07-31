---
paths:
  - "scripts/*.js"
  - "scripts/shared/*.js"
---

# workspace解決と実行時状態の置き場所

- 新しいスクリプトが「今どのworkspaceで動いているか」を必要とする場合、独自の解決ロジックを書かない。必ず `scripts/shared/workspace.js` の `resolveWorkspace(workspaceArg)` を使う。これは `GH_MAESTRO_WORKSPACE` env > `--workspace` 引数 > CWD上方探索の順で解決し、結果がホームディレクトリ等 managed root（`~/.gh-maestro/`）と衝突する場合は `null` を返す（`if (!workspace) { ...エラー...; process.exit(1); }` という定型パターンで安全に扱える）。
- PID/lock等「install.jsが絶対に消してはいけない、プロセスが生きている間だけ意味を持つ状態」は、`<workspace>/.gh-maestro/` にすら置かない。`scripts/shared/storage-layout.js` の `runtimeRoot()`/`workspaceRuntimeDir()` を使い、OS標準のstateディレクトリ（`process-lifecycle.js` のPID registryが参考実装）に置く。
- `<workspace>/.gh-maestro/`（`workers.json`・`assistants.json`・cursor類等）はinstall.jsの管理外なので、直接書いて問題ない。危険なのは「`.gh-maestro`という文字列を書くこと」自体ではなく、「`workspace`の値がhomeと衝突しうること」である。

**実障害（Issue #214）**: `install.js` は `~/.gh-maestro/` 配下を「install自身が書いたものだけを残し、それ以外は削除する」方式で権威的に管理している。`process-lifecycle.js` のPID registryが、workspace解決のバグにより `~/.gh-maestro/pids` に作られてしまい、次回install実行時に無条件削除された。稼働中プロセスの生存判定が壊れ、誤killが発生した。

**この種の間違いはlint/CIでは検知できない**（`scripts/`配下30ファイルが`.gh-maestro`という文字列を正当に使っており、パターンマッチでは大量の誤検知になる。壊れたコードは他の正しい呼び出し箇所と見た目が同一で、間違っていたのは実行時の値だけだった）。`assertValidWorkspace()`/`resolveWorkspace()`の実行時ガードが唯一有効な防御であり、レビュー時は「`.gh-maestro`という文字を見たか」ではなく「`workspace`変数が`resolveWorkspace()`を経由しているか」を確認する。
