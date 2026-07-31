# Rules

- UI text must be Korean.
- Source code comments must be English only.
- Credentials must not be stored as plaintext project files.
- `requiresLogin` is only a metadata flag for future secure login/session handling and must not collect or store raw passwords.
- SNS login passwords must not be stored in `.env`; use a user-driven login window, existing browser session references, access tokens, or OS keychain references.
- Every state-changing (`POST`/`PUT`/`DELETE`) `/api/*` handler in `vite.config.mts` must check the request's Origin/Sec-Fetch-Site before doing any work, since this project's custom middleware registration bypasses Vite's own CORS layer (see Wave 16 troubleshooting notes) and the dev server has no other cross-origin protection.

## PDF Maker

- PDF page-count split volumes must derive each output title, cover date, and filename from the chunk's actual first/last post dates, not from the original full requested range or a "target pages" label.
- PDF year-list parsing must reject reversed explicit ranges (e.g. `2024-2009`) instead of normalizing them with `Math.min`/`Math.max`; silently swapping the bounds hides the user's typo.
- Image-only PDF post pages must use the same contextual header contract as text pages: platform, title, date, then the image body area.
