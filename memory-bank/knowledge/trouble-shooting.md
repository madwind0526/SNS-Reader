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
- Avoid writing Korean source text through PowerShell pipeline scripts unless the input/output encoding is explicitly controlled. Prefer `apply_patch` or verify the saved file with Node `fs.readFileSync(path, "utf8")`; otherwise Korean literals can become plain question-mark placeholders even when the script itself succeeds.
- Local Ollama enrichment can be slow enough that multi-file batches appear stalled. Log the relative Markdown path before every LLM call and set a per-request timeout so the blocked file is visible.
- LLM enrichment must skip generated backup folders such as `_archive`. Otherwise resumable year/provider batches can spend time enriching backup copies and make progress counts misleading.
- If a compact filter control mixes `<label>` wrappers and non-label controls in one grid row, global label margins can vertically offset only the label cells. Override the component-specific label margin before tuning slider geometry.

# Wave 15 Troubleshooting

- Mesh View blanked out when rendering all cards because `edges.push(...edgeWeights.values())` exceeded the browser call-stack limit with a large edge map. Use `Array.from(edgeWeights.values())` instead of spread-pushing into an array inside large graph loops.
- PDF font preview and rendering need explicit font-file paths plus `@font-face` loading in the browser; relying on CSS family names alone made several Korean font options render identically.
- Generated PDF cards need a separate transparent hit area and a higher z-index delete button so card preview click and PDF deletion do not compete for the same click target.

# Wave 16 Troubleshooting

- Facebook/Threads relative-time labels ("3시간", "1일") are only shown for roughly the last day or two before the UI switches to an absolute "N월 N일" date. A date parser that only recognizes the absolute format will silently skip every recently-posted item entirely (not just mis-date it) - this made "SNS Update" appear to work while never actually picking up same-day posts. Parse both relative and absolute forms.
- A Vite plugin that calls `server.middlewares.use(...)` directly inside `configureServer(server) { ... }` (i.e. does not return a post-hook function) gets registered *before* Vite's own internal middleware stack, including its CORS middleware. Custom `/api/*` routes built this way never get CORS headers applied and are reachable via blind cross-origin POST from any page open in a browser while the dev server runs - add an Origin/Sec-Fetch-Site check inside each state-changing handler.
- A module-level TTL cache (e.g. `markdownCardsCache`) that returns the same object reference on a cache hit must never be mutated in place by a caller (`cardsPayload.cards = filtered`) - that permanently corrupts the shared cache for every other consumer. Always spread into a new object/array before narrowing a cached payload.
- Facebook's crawler-facing `og:image` sometimes resolves to `lookaside.fbsbx.com/lookaside/crawler/media/?media_id=...`, a proxy that only returns real image bytes for the same crawler user-agent (`facebookexternalhit/1.1`) used to discover it - any other user-agent gets an HTML page with a client-side JS redirect instead of raw bytes. A downloader that doesn't check `content-type` starts with `image/` before saving will silently write that redirect page into a `.jpg` file.
- Re-running a Facebook browser-session capture produced duplicate files across days because the post ID was derived from the computed (relative-time-parsed) date, which can drift by a day between runs of the same post. Deriving the ID from the permalink's `pfbid`/`story_fbid`/video id instead makes it stable regardless of when the date is computed.
- A DOM-wide `<img>` scan used as a fallback when a post's `og:image` looked like a fallback/placeholder picked up the *parent* post's images on a Threads reply's permalink page (Threads renders the full parent thread above a reply). Any per-post image-recovery fallback that scans the whole rendered page, not just that post's own content region, risks misattributing images to the wrong post - verify by opening the actual downloaded file before trusting it.
