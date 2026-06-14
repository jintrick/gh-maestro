---
source_url: https://github.com/github/gh-aw/blob/79d43a9e415e5a1adc7b7a3207ae41e3257ee216/pkg/workflow/testdata/wasm_golden/fixtures/shared/mcp/tavily.md
original_title: tavily
fetched_at: 2026-06-14T00:40:12.517442+00:00
---

---
mcp-servers:
  tavily:
    type: http
    url: "https://mcp.tavily.com/mcp/"
    headers:
      Authorization: "Bearer ${{ secrets.TAVILY_API_KEY }}"
    allowed: ["*"]
---
