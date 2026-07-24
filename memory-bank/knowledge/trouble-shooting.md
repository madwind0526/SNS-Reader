# Troubleshooting

Reusable bug fixes and environment notes will be accumulated here.

## Initial Environment Notes

- `C:\Codex\memory-bank\INDEX.md` was not available during project initialization.
- `C:\Codex\_template\` was not available, so the project memory-bank was initialized manually.
- `vite.config.ts` was renamed to `vite.config.mts` because TypeScript NodeNext resolved Vite through the CommonJS declaration path and could not see `defineConfig`.

## Vite Dev API

- When `vite.config.mts` middleware changes, the already-running Vite dev server may not expose the new route until the server is restarted.
# Wave 5 Troubleshooting

- If PowerShell displays mojibake for Korean Markdown, verify with Node `fs.readFileSync(path, "utf8")` before assuming the file is corrupt. The 2026-05-14 Facebook Markdown file contains a short body and timecodes but no image embeds.
- If Facebook export videos appear missing from cards, check whether the importer is collecting video URI extensions and generating poster images. Current verified output includes 5 `.mp4` files and 5 `image-*-video-poster.jpg` files.
- If detail modal images look flattened, avoid tiny fixed strip dimensions. A 210px by 164px button with `object-fit: cover` keeps thumbnails visually stable.
- LLM enrichment must not silently fall back to keyword/rule-based summaries when the API key is missing. Fail loudly unless `SNS_READER_LLM_MODE=local` or `--local` is explicitly used for preview/testing.
