---
name: gh-maestro-init
description: 対象プロジェクトのlint/format/typecheck/test設定を調査し、gh-maestroのpre-commit/pre-pushフックが検出できる状態になっているかを確認・整備する。人間が対象プロジェクトのルートディレクトリで明示的に呼び出す。
---

gh-maestroのpre-commit/pre-pushフック（`run-checks.js`）は、対象プロジェクトの`package.json`にある規約（`lint-staged`設定・`test`/`typecheck`スクリプトの有無）を検出して自動実行する。検出できるものが無ければ、そのチェックは黙ってスキップされる（fail-open）。このスキルは、その検出対象が実際に整っているかを人間と一緒に確認し、欠けていれば**承認を得た上で**整備する。

## 前提

- 対象プロジェクトのルートディレクトリ（`package.json`が置かれている場所）で呼び出すこと
- `.gh-maestro/`の有無や`/gh-maestro`の起動状態は問わない（単独で呼び出してよい）
- Node/JS/TS（`package.json`ベース）以外のエコシステムは現時点で対象外（`run-checks.js`が未対応のため、整備しても効果がない）。`package.json`が存在しないプロジェクトでは、その旨を報告して終了する

## 手順

1. `package.json`を読み、以下を調査する:
   - `scripts.lint`（あれば、何のツールを叩いているか）
   - `scripts.test`
   - `scripts.typecheck` / `scripts["type-check"]`
   - `"lint-staged"`キー、または`.lintstagedrc*`/`lint-staged.config.*`ファイルの有無
   - `devDependencies`にESLint/Prettier/TypeScript等の主要ツールが入っているか
2. 調査結果を人間に一覧で報告する。特に以下を明示する:
   - pre-commitフックが実際に何かを検証する状態か（`lint-staged`設定の有無で決まる）
   - pre-pushフックが検証する項目（`test`/`typecheck`スクリプトの有無で決まる）
   - 検出されない項目があれば、それは今のままでは無条件にスキップされる、という事実
3. 欠けている項目について、整備するかどうかを人間に確認する。判断が要る点（ツール選定・globパターン・自動修正の可否等）は仮に決めず、選択肢を示して人間に選んでもらう。例:
   - `lint-staged`未設定だがESLint/Prettierが既に入っている → `lint-staged`導入を提案し、対象glob・実行コマンド（`eslint --fix`か`eslint`のみか等）を確認する
   - `typecheck`スクリプトが無いが`tsconfig.json`がある → `"typecheck": "tsc --noEmit"`をscriptsに追加してよいか確認する
   - 該当ツール自体（ESLint等）がプロジェクトに無い → 導入するかどうかは特に慎重に確認する（新規依存の追加は影響範囲が大きい）
4. 承認を得た項目のみ、`package.json`編集・設定ファイル作成・`npm install`を実行する。承認されなかった項目には手を付けない
5. 変更後、`node "{{SCRIPTS_PATH}}/hooks/run-checks.js" precommit .` および `node "{{SCRIPTS_PATH}}/hooks/run-checks.js" prepush .` を対象プロジェクトのルートで実行し、意図した検出結果になっているか実地確認する
6. 変更内容を人間に報告する。既存フック自体（`.git/hooks/pre-commit`/`pre-push`）はこのスキルでは触らない（`gh-maestro-setup.js`が別途管理する）

## 注意

- このスキルはpackage.json/設定ファイルを書き換えうるが、**承認されていない変更を先回りして行わない**
- `npm install`はこのプロジェクトのルートで実行してよい（gh-maestro自身のworktree運用にある「ルートでのnpm install禁止」制約は、gh-maestroのworktree間で共有node_modulesをjunctionリンクしている場合の話であり、対象プロジェクト側の話ではない）
- 対応言語を増やす（Python等）必要が出てきた場合は、このスキル単独では対応せず、`scripts/hooks/run-checks.js`側の検出ロジック拡張とセットで検討する（このスキルは既存の検出ロジックが見る場所を整備するだけで、検出ロジック自体は持たない）
