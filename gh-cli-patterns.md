# gh CLI よくある間違いパターン

## gh pr close は1件ずつ

```sh
# NG: 複数引数は受け付けない
gh pr close 283 284 292

# OK: ループで1件ずつ
for pr in 283 284 292; do
  gh pr close $pr --comment "理由"
done
```

## gh api --field body= のバッククォート消え

シェルがバッククォートをコマンド置換として解釈するため、本文が消える。

```sh
# NG: ダブルクォートだとバッククォートが消える
gh api ... --field body="本文に `code` が含まれる"

# OK: シングルクォートで囲む
gh api ... --field body='本文に `code` が含まれる'

# OK: ヒアドキュメント経由
gh pr create --body "$(cat <<'EOF'
本文に `code` が含まれる
EOF
)"
```

## gh issue create / gh pr create の --body は HEREDOC 推奨

複数行・特殊文字を含む場合はシングルクォート HEREDOC を使う。

```sh
gh issue create --title "タイトル" --body "$(cat <<'EOF'
## 本文

- 箇条書き
- `コード`

EOF
)"
```

## gh pr diff はリダイレクト不可

```sh
# NG: ページャーが介入してハングする場合がある
gh pr diff 123 | grep "pattern"

# OK: --patch オプションで標準出力に出す、またはそのままパイプ
gh pr diff 123 --patch | grep "pattern"
```
