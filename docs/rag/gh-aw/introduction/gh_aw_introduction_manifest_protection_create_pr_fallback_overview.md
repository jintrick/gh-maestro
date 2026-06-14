---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/actions/setup/md/manifest_protection_create_pr_fallback.md
original_title: manifest_protection_create_pr_fallback
fetched_at: 2026-06-14T00:40:04.158028+00:00
---

{main_body}

---

> [!WARNING]
> **Protected Files**
>
> This was originally intended as a pull request, but the patch modifies protected files. These files may affect project dependencies, CI/CD pipelines, or agent behaviour. **Please review the changes carefully** before creating the pull request.
>
> **[Click here to create the pull request once you have reviewed the changes]({create_pr_url})**
>
> <details>
> <summary>Protected files</summary>
>
> {files}
>
> </details>

To route changes like this to a review issue instead of blocking, configure `protected-files: fallback-to-issue` in your workflow configuration.

{footer}
