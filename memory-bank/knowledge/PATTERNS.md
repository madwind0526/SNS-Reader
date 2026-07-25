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

# Wave 8 Patterns

- Web file picker archive imports should stream the selected `File` body to a temporary server-side zip before passing it to importer scripts; browser file inputs cannot reliably expose local absolute paths.
- Archive imports should validate both filename hints and internal archive structure. Filename mismatches are useful non-blocking UI warnings, while internal zip structure mismatches should block the import before importer scripts run.
- Naver Blog latest-post import can use RSS for discovery and `m.blog.naver.com/{blogId}/{logNo}` for full SmartEditor body extraction.
- Naver Blog all-post discovery works through `PostTitleListAsync.naver?blogId={blogId}&currentPage={n}&categoryNo=0&countPerPage=30`; results include `logNo`, `categoryNo`, `addDate`, and `totalCount`, and should be deduplicated by `logNo`.
- Naver Blog paragraph extraction should join captured editor paragraphs with blank Markdown lines. Naver uses visual paragraph spacing and zero-width blank paragraphs, so single-newline joins make imported posts look incomplete or compressed.
- Old Naver Blog posts can store body text inside `post_ct` or `postViewArea` as raw `<FONT>...<BR>...</FONT>` without `<p>` tags. The crawler needs a fallback that converts `<BR>` to Markdown line breaks and strips remaining tags.
- Naver Blog MemoLog uses `MemologPostList.naver` and `MemologPostView.naver`, not `PostTitleListAsync.naver`. List pages can repeat the final page after the real end, so discovery should stop when no new `logNo` appears.
- Naver Blog update imports must scan existing Markdown `post_id` values before writing because RSS/latest and date-range updates can include already imported boundary posts.
- Sidebar Update should execute only SNS accounts with `exportToObsidian !== false`. Naver Blog can run date-range updates from the latest converted Markdown date; Facebook, Instagram, and Threads require a logged-in browser connector for practical incremental updates.
- Login-based SNS incremental updates can use Chrome DevTools Protocol via `SNS_READER_CDP_URL`. Facebook profile crawling works by selecting `[role="article"]`, expanding each visible article's `See more` or Korean equivalent, reading expanded text, then scrolling and repeating.
- Naver Blog video posts may expose a poster image only through `og:image`. Regular Naver Blog import should use usable `og:image` values as image fallbacks.
- Existing Naver Blog Markdown can be repaired without full re-import by scanning `image_count: 0` files, refetching `source_url` or its mobile URL, downloading a usable `og:image`, and updating only `has_images`, `image_count`, the Images section, and `meta.json`.
- Browser-session updates should default to a Playwright persistent Chrome profile under `data/runtime/browser-profile`; CDP remains an optional fallback for already-running debug Chrome sessions.
- The Login Browser action should open the persistent profile visibly and return immediately from the API; users log in manually, close the browser, then Update reopens the same profile for crawling.
- Archive import and incremental update flows should run provider-scoped duplicate cleanup before validation/enrichment. The dedupe key must include `platform` so mirrored Facebook, Instagram, Threads, YouTube, and Naver Blog posts remain separate records, while same-provider `post_id` or exact body/media fingerprints collapse to one Markdown card.
- Generated backup folders such as `_archive` must be excluded from card scans and dedupe scans unless an explicit recovery workflow needs them.
- PDF Maker can reuse the `/api/markdown-cards` parser as its source of truth. Store generated PDF metadata in a sidecar JSON next to the PDF so the UI can list title, range, page count, and post count without reparsing the PDF.
- PDFKit footer text must stay inside the page content box. Writing footer text below `page.height - page.margins.bottom` can trigger automatic page creation and make metadata page counts diverge from the actual PDF.
- PDF text helpers should always reset `x` to the page margin after drawing absolute-position charts or word clouds. Otherwise subsequent headings and body text can inherit the chart cursor and render off to the side.
- PDF Word Cloud labels should use bare tag text without `#` for better visual weight, while Markdown TAG sections can retain Obsidian-style hash tags.
- Long PDF body text should be manually wrapped into page-sized chunks before drawing a background text box. Letting PDFKit auto-flow text out of a filled rectangle leaves later pages without the intended box background.
- PDF preview UI should render the selected page in a non-scrolled right pane with `object-fit: contain` and fixed inset padding, while the left page navigator remains independently scrollable.
- PDF page-count split should create full book volumes after estimating physical pages, then merge a final remainder under the configured minimum page threshold into the previous volume.
- App Mesh View can reuse parsed Markdown card tags directly: compute top non-platform tags, place tag nodes on an inner ring, post nodes on an outer ring, and connect posts to their matching top tags.
- LLM enrichment should support `--year`, `--date-from`, `--date-to`, and `--limit` so large local-model runs can be resumed and diagnosed by batch.
- Word Cloud layout should measure each label before placement, cap long labels relative to the fixed panel width, place labels by spiral search, and skip only labels that cannot be placed inside bounds.
