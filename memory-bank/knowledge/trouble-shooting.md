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

# Wave 8 Troubleshooting

- Generated Markdown section parsing must stop only at known app-owned sections such as `Date`, `Body`, `Images`, `Videos`, `Comments`, `Summary`, and `Source`. Stopping at any `##` heading truncates user-authored Markdown bodies such as Naver Blog posts with headings.
- Verify generated Korean Markdown with Node `fs.readFileSync(path, "utf8")`; PowerShell `Get-Content` can display Korean as mojibake even when the file is valid UTF-8.
- Naver Blog public all-post list can differ from the logged-in sidebar count. The public `categoryNo=0` API showed fewer posts than the owner UI, likely because private, hidden, or memo content is not exposed the same way.
- Naver Blog blocked scraped posts can contain only a Korean message meaning scraped posts cannot be re-scraped. These should be skipped before Markdown writing and removed from existing generated output.
- Naver Blog image-only posts should not be archived as SNS Reader text cards. Treat `has_images: true` with placeholder or empty body as cleanup candidates, delete the matching Markdown plus media folder, and skip future imports before image download/write.
- Large Naver Blog crawls can hit transient post or image `fetch failed` errors. Importers should catch per-post body and image fetch errors, skip only the failing item, and keep the batch running.
- Naver Blog MemoLog body extraction must target the exact `view` class inside `post-view{logNo}` or `postViewArea`. Broad class matching can accidentally include hidden UI data or internal JSON, and balanced HTML extraction should not mix `lastIndex` with `slice().matchAll()`.
- Naver Blog missing-image repair restored 369 of 1,772 checked `image_count: 0` candidates from usable `og:image`; the remaining 1,403 had no usable Open Graph image and should stay unchanged unless a richer crawler source is added.
- If Playwright persistent profile launch fails with a profile lock, the Login Browser is probably still open. Close the login browser window before running Update with the same profile.
- Re-running a Facebook/Meta archive import can create duplicate cards when generated filenames use per-run sequence numbers and the importer does not check existing `post_id` or content fingerprints. Clean existing output with `tools/dedupe-sns-markdown.mjs --apply`, then keep import/update paths wired through the same dedupe step.
