# Code Review Summary (2026-07-27)

## Files Reviewed

| File | Lines | Role |
|------|-------|------|
| `src/App.tsx` | 4,573 | Main React UI (all views, modals, state) |
| `vite.config.mts` | 4,298 | Dev server + API routes + PDF generation + Markdown pipeline |
| `electron/main.ts` | 64 | Electron main process (settings IPC) |
| `electron/preload.ts` | 8 | Context bridge |
| `src/main.tsx` | 10 | React entry point |
| `src/types/domain.ts` | 106 | Core type definitions |
| `package.json` | 44 | Dependencies & scripts |

---

## ✅ Strengths

### Architecture
- **Clear type system** — Domain types (`SnsPlatform`, `PdfTextStyle`, `AppSettings`, etc.) are well-defined in `domain.ts` and used consistently.
- **Single-file pattern done well** — `App.tsx` consolidates all UI components (13 modals, 5 views) into one file with clear function-per-component structure. While large, each component is readable.
- **Vite config as server** — The dev server doubles as an API backend (`/api/markdown-cards`, `/api/env`, `/api/create-pdf`, etc.) without needing a separate server process. Clever pattern for an Electron app.

### Data Handling
- **Safe async patterns** — Consistent use of `try/catch` + `finally` for loading/refresh states. Guard clauses for busy states (e.g., `isSnsReading`, `isCreatingPdf`).
- **Cache with TTL** — `markdownCardsCache` (30s TTL) in `vite.config.mts` avoids redundant file scans.
- **Concurrency controlled** — `mapWithConcurrency(64)` for Markdown card building prevents overwhelming I/O.

### PDF Generation
- **High-quality output** — Multi-column layout, justified mosaic image rows, corner decorations, font embedding via fontkit, Korean text support.
- **Robust image pipeline** — Naver image quality upgrade (`ensureHighQualityPdfImage`), seeded/random order, collage layout.
- **Smart chunking** — `chunkPostsByTargetPages` splits posts into volumes by estimated page cost.

### Mesh View Visualization
- **Sophisticated layout** — Fibonacci spiral with golden angle, jitter, degree-based radius scaling, balanced edge selection.
- **Performance-conscious** — Memoized with `useMemo`, viewport clamping, pointer capture for drag.

### Security
- **API key masking** — `MASKED_SECRET_VALUE` pattern prevents re-displaying stored keys.
- **Password never stored in plaintext** — Only .env file used (following AGENTS.md rule).
- **Path traversal protection** — `isPathInside()` check prevents path escape.

---

## ⚠️ Issues & Recommendations

### 1. Single-file size (src/App.tsx, 4,573 lines)

**Problem:** `App.tsx` combines ~20 components in one file. It works but hurts maintainability.

**Recommendation:** Extract into `src/components/`:
- `ConvertedFileLibrary.tsx`, `MeshView.tsx`, `PdfWriteView.tsx`, `PdfViewerModal.tsx`, `PdfCreatorModal.tsx`
- `PostDetailModal.tsx`, `ImagePreviewModal.tsx`, `FilterPanelModal.tsx`, `SearchPanelModal.tsx`, `LlmQueryModal.tsx`
- `PlatformSidebar.tsx`, `TopToolbar.tsx`, `SettingsView.tsx`, `EditSnsAccountModal.tsx`
- Utility components: `CardImagePreview.tsx`, `Panel.tsx`, `FieldSelector.tsx`, `Segmented.tsx`

### 2. vite.config.mts is too large (4,298 lines)

**Problem:** API routes, PDF generation, Markdown processing, font scanning, and env management are all in one Vite config file.

**Recommendation:** Extract into `src/server/`:
- `src/server/api-routes.ts` — Route handlers
- `src/server/markdown-cards.ts` — Card building logic
- `src/server/pdf-generator.ts` — PDF creation pipeline
- `src/server/pdf-layout.ts` — Text/image layout helpers
- `src/server/env.ts` — .env read/write
- `src/server/fonts.ts` — Font scanning

### 3. Stale `prevSettings` check inside `handleSave`

**Observation:** `handleSave` in `App.tsx` (line 907) calls `saveSettings(settings)` then `refreshConvertedPosts()`, but `settings` is the current state which may already have an outdated reference if multiple changes happen rapidly. Consider using a callback pattern.

### 4. `PdfWriterModal` / `PdfViewerModal` accessibility

**Issue:** Some modals use `aria-label` in Korean inconsistently. `PdfCreatorModal` uses Korean labels for UI text but English for `aria-label` attributes. Recommendation: Make `aria-label` values consistently Korean for user-facing elements.

### 5. Duplicate LLM config modals

**Observation:** `LlmProviderConfigDialog` (line 4135) and `LlmProviderConfigModal` (line 4287) in `App.tsx` are nearly identical (same fields, same submit logic) — only diff is `LlmProviderConfigDialog` handles existing key masking. Could be consolidated into one component.

### 6. No error boundary

**Recommendation:** Add a React error boundary component to prevent the entire app from crashing on uncaught render errors. Wrap `<App />` in `src/main.tsx`.

### 7. `tmp/` directory not in `.gitignore`

**Confirmed by `active-context.md`:** `tmp/` directory contains test artifacts and is untracked but not excluded by `.gitignore`. Add `tmp/` to `.gitignore`.

### 8. Type safety gaps

- `buildMarkdownCard` returns `any` typed object — could use `ConvertedPost` type from client.
- `parseSimpleFrontmatter` returns `Record<string, string | string[]>` but frontmatter keys are not validated.
- Some event handler types use `any` in `vite.config.mts` (e.g., `doc: any` in PDF functions) — acceptable for PDFKit's dynamic API but could use interface wrappers.

### 9. Missing `X` platform import script check

`scriptArgsForArchiveImport` references `tools/import-x-archive.mjs` (line 205) — verify this file exists or will be created, as it's not in the current file listing.

### 10. UI: No loading skeleton for initial data load

**Observation:** On initial load (`useEffect` in App line 726), the UI shows immediately but may briefly show empty states before API responses arrive. Consider adding a brief loading skeleton.

---

## ✅ Good Practices Observed

| Practice | Evidence |
|----------|----------|
| Immutable state updates | All `setSettings` use spread + partial update pattern |
| Cleanup on unmount | `useEffect` returns cleanup functions (line 745, 770) |
| Dynamic import / code-split ready | Component extraction would benefit from `React.lazy` |
| Consistent error messages | Korean for user-facing, English for code comments |
| Path normalization | `normalizePathForCompare` + `isPathInside` for security |
| Debounced polling | 5-second interval refresh with visibility check |
| Keyboard accessibility | `onKeyDown` handlers with Enter/Space on cards |
| Guard against rapid clicks | Boolean state flags (`isCreating`, `isReading`) |

---

## Quick Stats

| Metric | Value |
|--------|-------|
| Total source lines (reviewed) | ~9,000 |
| Components in App.tsx | ~20 |
| API endpoints in vite.config.mts | ~14 |
| Type definitions in domain.ts | ~15 interfaces/types |
| Dependencies | ~12 (lean) |
| Max file size | 4,573 lines (App.tsx) |
| Second largest | 4,298 lines (vite.config.mts) |