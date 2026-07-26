# Active Context

- Current Obsidian SNS root is `F:\Obsidian\PC-Madwind\SNS`; active Markdown audit passes with 3901/3901 files enriched and 0 missing summaries/TAGs.
- One zero-byte Facebook markdown file was moved to `F:\Obsidian\PC-Madwind\SNS\facebook\_archive\empty\2021-06` so it is preserved but excluded from active DB/audit.
- `tools/enrich-sns-markdown.mjs` supports resumable LLM enrichment through `--results-file`, `--no-apply`, `--apply-results`, Ollama batch mode, JSON repair, retries, and low-information fallbacks.
- `tools/audit-sns-enrichment.mjs` verifies active SNS markdown enrichment by provider/year and excludes `_archive`.
- Mesh View is available as an app view from the top toolbar, keeps the right Top TAG panel, renders all posts in a sphere-like spread, supports wheel zoom plus left-drag pan, and highlights selected Top TAG edges without hiding current nodes.
- PDF Maker supports portrait/landscape, cover image replacement, body window count constraints, year/date/page split modes, 30-page minimum page-count chunks, image layout modes, typography settings, collages, overview pages, month headers, body-page decorations, stable `SNS YYYY.MM-YYYY.MM.pdf` output names, runtime-only PDF metadata, usable-image filtering, sample-image collage fallback, and app-matched post-to-post Mesh rendering.
- PDF overview Summary now builds a period-level narrative instead of concatenating repeated per-post summaries, and PDF image rendering can upgrade low-resolution Naver Blog images through `meta.json` source URLs when larger Pstatic variants are available.
- PDF Creator now blocks reversed year ranges such as `2024-2009` before generation, and image-only PDF post pages include SNS, title, date, and then the image body area.
- Top toolbar now keeps only Mesh, SNS, PDF, login, Setting, and power actions; Theme selection moved into General Setting.
- PDF Maker defaults keep Split mode as Year list and use `assets\Cover-Long3.jpeg` as the portrait cover image.
- Next likely focus: verify app UI reload reflects new enriched TAGs/Mesh data, then continue PDF/Mesh polish or update-crawling hardening as requested.
