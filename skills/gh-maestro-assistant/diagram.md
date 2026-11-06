# assistant の図解手順

人間が図解を求めたときだけ、この手順を使う。図解を自分から提案したり、質問されていない内容をHTML化したりしない。

## 図の選び方

- 時系列や処理の受け渡しは、矢印付きのフローまたはシーケンス図にする。
- 階層や責務の関係は、入れ子のボックスまたはツリーにする。
- 状態の遷移は、状態ノードと遷移矢印にする。
- 数値の比較は、表または小さな棒グラフにする。

図の下または横に、図だけでは表せない前提・制約・用語を短く添える。説明文と図の内容を一致させ、確認できない事実を図に入れない。

## HTMLの要件

保存先は次のIssue別パスに固定する。

```text
$WORKSPACE/.gh-maestro/assistants/issue-$ISSUE/diagram.html
```

親ディレクトリを作成してから、UTF-8の単一HTMLファイルを書き出す。HTMLは次の条件をすべて満たす。

- 外部のスクリプト、スタイルシート、フォント、画像、ネットワークAPIを読み込まない。
- 図形はHTML/CSSまたはインラインSVGで表現する。Mermaid CDNなどの外部依存を使わない。
- `meta viewport`、見出し、図の説明、必要な凡例を含める。
- 明るい配色と暗い配色の両方で読めるよう、`prefers-color-scheme: dark` を使い、背景・文字・線・アクセントのコントラストを確保する。
- 色だけに意味を持たせず、ラベル・矢印・形でも関係を区別する。
- インラインHTMLとしてブラウザで直接開ける。ファイルURIからの相対パスや外部アセットに依存しない。

最小構成は次の形にする。

```html
<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Issue #ISSUE — 図解タイトル</title>
  <style>
    :root { color-scheme: light dark; --bg: #f7f8fc; --fg: #172033; --card: #fff; --line: #52627a; --accent: #2563eb; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #111827; --fg: #eef2ff; --card: #1f2937; --line: #a5b4fc; --accent: #93c5fd; }
    }
    body { margin: 0; padding: 2rem; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
    .diagram { max-width: 72rem; margin: auto; }
    .node { fill: var(--card); stroke: var(--line); stroke-width: 2; }
    .edge { stroke: var(--accent); stroke-width: 2.5; marker-end: url(#arrow); }
    text { fill: var(--fg); }
  </style>
</head>
<body>
  <main class="diagram">
    <h1>図解タイトル</h1>
    <p>この図が説明する範囲と前提。</p>
    <svg viewBox="0 0 800 360" role="img" aria-labelledby="diagram-title diagram-desc">
      <title id="diagram-title">図のタイトル</title>
      <desc id="diagram-desc">図の関係を文章でも説明する。</desc>
      <defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="currentColor" /></marker></defs>
      <!-- 内容に合わせたノードと矢印をここに置く -->
    </svg>
  </main>
</body>
</html>
```

## 保存と起動

Windowsでは、ファイルを書き出した後に次を実行して既定のブラウザで開く。

```powershell
Start-Process -FilePath (Resolve-Path "$WORKSPACE/.gh-maestro/assistants/issue-$ISSUE/diagram.html")
```

`Start-Process` が実行できなかった場合は、HTMLの保存に成功したかを確認し、ブラウザを開けなかったエラーを人間へ伝える。別のブラウザや外部サーバーを勝手に起動して成功扱いにしない。既存の同じIssueの図解は上書きして最新の説明に更新してよいが、別Issueのファイルは変更しない。
