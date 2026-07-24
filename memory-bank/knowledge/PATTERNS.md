# Patterns

Reusable implementation patterns for this project will be accumulated here.

## UI Shell

- The main app shell uses a full-width top toolbar, a full-width bottom system message row, and an icon-only left account sidebar between them.
- Converted Markdown and generated PDF outputs are both represented as card grids in the main window.
- Settings are currently persisted through `localStorage` in `src/settings/storage.ts`; this should move to Electron-backed local files when the desktop shell is connected.
- Saved SNS account rows drive the left sidebar immediately, with count `0` until real import/scan data is available.
- Sidebar card tools use modal dialogs: Search edits the shared toolbar search query, Filter applies image/comment/tag predicates, and Query opens an LLM-style Q&A panel over generated SNS Markdown files.
- Card Filter supports platform multi-select, date range, comment author text, tag text, and image/comment/tag presence predicates.
- Query LLM provider options are loaded from `.env` through UI-safe `VITE_LLM_*` variables; API keys must stay in server-only variables and be read by the Electron/backend layer.

## Data Flow

- Converted Markdown cards are currently sample data in `src/App.tsx`; the next implementation should scan only the configured SNS Reader output folder and parse generated Markdown/frontmatter.
- `SnsAccountConfig.exportToObsidian` controls whether a saved URL is used for future Markdown generation/update. Existing generated Markdown cards remain visible and countable regardless of that checkbox.
- LLM Query should run against only SNS Reader generated Markdown files, not every Markdown file in an Obsidian vault.
- Query LLM selection is stored in `AppSettings.selectedLlmProvider`; changing it from the Query modal saves the new default immediately.
- PDF split settings are stored in `AppSettings` as `pdfYear`, `pdfDateFrom`, `pdfDateTo`, and `pdfPageCount` for future PDF generation.
- Settings are persisted through `src/settings/storage.ts` to localStorage plus either the Electron bridge or the Vite dev API at `/api/settings`; both file paths resolve to `data/runtime/app-settings.json`.
- SNS browser-session import should read enabled accounts from settings, not target URL env vars, so UI settings remain the source of truth.
- A browser-session raw capture can collect visible Facebook posts from a logged-in Chrome profile and write Markdown grouped as `platform/YYYY-MM/post.md` with post metadata under `assets/{postSlug}/meta.json`.
- Browser-captured image lists should filter out platform UI assets such as `static.xx.fbcdn.net`, `/rsrc.php`, `emoji.php`, and `data:image` URLs before writing Markdown.
- Browser-session import needs explicit follow-up work for expanding collapsed post text, opening comments, downloading image assets, creating collages, and robust date parsing from platform-specific date labels.
- Facebook official Accounts Center export supports an app-friendly path: profile selection, export to device, specific information, date range, JSON format, and media quality. Export submission can require password confirmation, which must remain a user-entered browser step.
- `tools/import-facebook-export.mjs` imports a downloaded Facebook/Meta JSON export zip, discovers post entries, copies local media into post-specific `assets/{stem}/` folders, and writes one Obsidian Markdown file per post under `facebook/YYYY-MM/`.
- Threads is treated as its own `SnsPlatform` rather than `other`; generated `SNS/Threads` Markdown should map back to the saved Threads account by URL or label for sidebar counts and filtering.
- Threads export replies from the same account can be continuation text caused by post length limits. The importer should merge `is_reply` entries into the nearest parent post only when the reply target matches the configured account handle, and should not create separate no-image cards for those continuation fragments.
- Threads exports can store video files at extensionless `media/posts/...` paths. Detect media type from file signatures instead of relying on path extensions, copy videos as `.mp4`, and generate `image-*-video-poster.jpg` for card thumbnails.
- YouTube Takeout community posts are imported from `YouTube 및 YouTube Music/게시물/게시물.csv`; parse the JSON-like `게시물 텍스트` field by wrapping it as an array, then map `이미지 N 이름` fields to same-folder media files by basename.
- The Vite dev API exposes generated cards at `/api/markdown-cards` by scanning only the configured `obsidianRootFolder`, parsing simple frontmatter plus body/image sections, and serving local thumbnails through `/api/media` with a root-path containment check.
- Markdown cards should expose `body`, `summaryLines`, `tags`, `imageUrls`, and `sourceUrl` to the UI so the card list, detail modal, image collage, and zoom preview can use the same parsed data.
- `tools/enrich-sns-markdown.mjs` can enrich generated Facebook Markdown with two-line summaries and up to 10 body-based tags, updating both frontmatter and the `## Summary` section.
- `tools/enrich-sns-markdown.mjs` sends Markdown title/date/source/body to the configured LLM provider and writes `summary_provider` plus `summary_model` into frontmatter so generated summaries can be audited later.
- Local Ollama enrichment uses `OLLAMA_BASE_URL` and the native `/api/chat` endpoint without requiring an API key for localhost. The current default local model is `gemma4:latest`.
- LLM enrichment prompts should stay in clean UTF-8 Korean and request JSON-only output with explicit summary and tag quality rules; verify generated Markdown with a Node UTF-8 read instead of PowerShell display output.
# Wave 5 Patterns

- SNS cards should use a fixed-height layout with an independently scrollable card grid so card deletion and long body previews cannot push the lower sidebar tools out of place.
- Card thumbnails should render the first media item with `object-fit: cover` and centered `object-position`, then overlay a fixed bottom band and centered count badge for consistent portrait/landscape previews.
- Sidebar platform count buttons need enough fixed horizontal space for 5-digit counts and should hide horizontal overflow in the vertical sidebar; only the mobile horizontal sidebar should allow x-scrolling.
- Post detail image previews should separate detail-strip thumbnails from the full image preview modal. The full preview supports wheel zoom and pointer-drag pan through explicit zoom and pan state.
- In long post detail modals, keep media thumbnails outside the scrollable body as a dedicated bottom grid row. This prevents the body viewport and horizontal scrollbar from clipping thumbnail bottoms.
- Full image preview should use viewport-based `max-width` and `max-height`, not percentage max-height inside a grid container. Percentage max-height allowed portrait images to exceed the shell height.
- Facebook official export video media can be represented in the Markdown/card UI by copying the original video and generating a `*-video-poster.jpg` image with `ffmpeg`; the poster participates in normal image preview rendering.
- Facebook browser-session captures must not write feed-card text directly when it contains collapsed UI markers. Extract body text from the post permalink view, stop before reactions/comments/media-count UI, and fail validation when body or title still contains collapsed text.
