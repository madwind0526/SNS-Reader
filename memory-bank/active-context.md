# Active Context

- Current Obsidian SNS root is `F:\Obsidian\PC-Madwind\SNS`; X archive import added 838 original tweets only, excluding 219 replies and 7 retweets.
- Active Markdown validation passes after X import; X summaries/TAG enrichment is not yet run.
- Wave 15 (Mesh View crash fix + light-mode visibility + PDF maker polish) is flushed; docs and `package.json` version realigned to actual progress on 2026-07-26.
- Uncommitted change in `vite.config.mts` (134 insertions / 96 deletions) is still pending review/commit.
- `tmp/` (PDF render/cover test artifacts, one corrupted `App.tsx` backup) is untracked and not in `.gitignore` — needs cleanup or a gitignore entry.
- Next likely focus: verify app UI reload reflects newly enriched TAGs/Mesh data, then start Wave 6 "Packaging" work (Windows installer via electron-builder, settings migration, error/recovery screen) since collectors, Obsidian export, and PDF export are all functionally complete.
