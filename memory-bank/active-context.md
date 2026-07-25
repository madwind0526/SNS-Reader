# Active Context

- Current Obsidian SNS root is `F:\Obsidian\PC-Madwind\SNS`; Markdown validation passes and provider-scoped duplicate dry-run reports 0 duplicates.
- PDF output root is `F:\Obsidian\PC-Madwind\PDF`; generated PDFs are listed as compact cards with cover thumbnails and centered metadata.
- PDF preview modal uses a left scrollable page navigator and a right single-page fitted preview; browser verification confirmed the right page image fits both X and Y.
- PDF Maker supports portrait/landscape, cover image replacement, body window count constraints, year/date/page split modes, 30-page minimum page-count chunks, image layout modes, typography settings, collages, overview pages, month headers, and body-page decorations.
- Word Cloud now uses colored, frequency-scaled labels without `#`, caps long/high-frequency words to the fixed panel, and passed a synthetic fixed-box placement test.
- Mesh View is available as an app view from the top toolbar, keeps the right Top TAG panel, renders all posts in a sphere-like spread, draws TAG-shared post links, and supports wheel zoom plus left-drag pan.
- Filter Connection range uses aligned min/max number boxes with a centered double slider.
- Archive Import and Update use the configured checked SNS accounts; imports/updates run dedupe and validation afterward.
- Update now records per-provider `updated/skipped/failed` results so a single SNS failure can be diagnosed without losing other SNS progress.
- `tools/enrich-sns-markdown.mjs` has clean UTF-8 Korean prompts, per-call timeout, per-file progress logging, `_archive` exclusion, and supports `--year`, `--date-from`, `--date-to`, and `--limit` for safe LLM enrichment batches.
- Large LLM enrichment is feasible but slow with local Ollama `gemma4:latest`; 2026 batches completed successfully but should be run in resumable chunks.
