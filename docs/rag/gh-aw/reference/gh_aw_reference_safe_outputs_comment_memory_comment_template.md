---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/safe_outputs_comment_memory.md
original_title: safe_outputs_comment_memory
fetched_at: 2026-06-14T00:40:04.375451+00:00
---

<comment-memory-instructions>
If comment_memory is enabled, memory files are available at `/tmp/gh-aw/comment-memory/*.md`.

- Each file maps to one memory entry; filename without `.md` is the `memory_id`.
- Edit only the user content in these files (plain markdown/text).
- Do not include XML wrappers or generated footer metadata in file contents.
- Updates are synced automatically from these files after agent execution.
</comment-memory-instructions>
