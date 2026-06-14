---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/docs/public/fonts/README.md
original_title: README
fetched_at: 2026-06-14T00:40:07.536195+00:00
---

# Fonts

This directory contains webfont files served by the docs site.

## Mona Sans

This repo bundles the minimal set of Mona Sans webfonts needed for the docs site.

Source: https://github.com/github/mona-sans (release 2.0.8)

Files used by the docs:

- `MonaSans-Regular.woff2` (font-weight: 400)
- `MonaSans-Bold.woff2` (font-weight: 700)

License text (required for redistribution under OFL-1.1):

- `MonaSans-LICENSE.txt`

The docs CSS registers these via `@font-face` and uses `"Mona Sans"` as the first choice in `--sl-font`.
