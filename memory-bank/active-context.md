# Active Context

- Current Obsidian SNS root is `F:\Obsidian\PC-Madwind\SNS`.
- Web UI loads generated Markdown cards only from the configured SNS Reader output folder through `/api/markdown-cards`; current Naver Blog API count is 1,898 cards, with 495 thumbnail-backed cards after missing-image repair.
- Archive split rule is Facebook posts from `2010-01-01` onward and Naver Blog posts through `2009-12-31` to avoid duplicate source overlap.
- Markdown validation passes with `tools/validate-sns-markdown.mjs`.
- Archive Import UI/API is connected for Facebook, Instagram, Threads, and YouTube zip files through `/api/import-archive`; optional post-import enrichment is available through `/api/enrich-markdown`.
- A sidebar Update button now calls `/api/sns-update` and runs checked SNS update connectors for Naver Blog, Facebook, and YouTube; Instagram and Threads are included as checked targets but currently return login-browser-connector warnings for incremental updates.
- Login browser-session update now defaults to Playwright persistent Chrome profile at `data/runtime/browser-profile`; `SNS_READER_CDP_URL` is optional fallback only.
- Naver Blog crawler handles RSS latest import, historical `PostTitleListAsync.naver` discovery, SmartEditor paragraphs, and older `<BR>`-only HTML posts.
- Naver Blog crawler skips blocked scraped posts, image-only posts, bodyless posts, and per-post fetch failures before saving Markdown.
- Naver Blog historical text-card import now covers `2004-10-09` through `2011-12-31`, plus one 2026 latest-post test card.
- Naver Blog MemoLog full import is complete with duplicate skipping and clean body extraction; current generated MemoLog count is 318.
- Naver Blog missing-image repair has scanned existing `image_count: 0` Markdown and restored 369 poster images from usable `og:image` values without re-importing bodies.
- Facebook export importer skips one-line birthday greeting posts before media copy/write; existing matching cards were removed from generated output.
- Next focus: log into the Playwright login browser once, then test checked SNS updates against the saved browser profile; add X archive importer after the X zip is ready.
