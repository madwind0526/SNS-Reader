# Cache

## Active Findings

- Mesh View blanked out when rendering all cards because `edges.push(...edgeWeights.values())` exceeded the browser call-stack limit with a large edge map. Use `Array.from(edgeWeights.values())` and avoid repeated spread-copy updates inside large graph loops.
- PDF overview summaries should be rebuilt at the period level instead of concatenating per-post summaries; low-information repeated summaries need filtering and replacement with a concise archive-level sentence.
- Naver Blog image metadata can point to low-resolution `postfiles.pstatic.net` URLs by default; appending `?type=w966` or related Naver image size parameters can recover higher-resolution originals for PDF output.
- PDF page-count split volumes must derive each output title, cover date, and filename from the chunk's actual first/last post dates, not from the original full requested range or a "target pages" label.
- PDF font preview and rendering need explicit font-file paths plus `@font-face` loading in the browser; relying on CSS family names alone makes several Korean font options appear identical.
- Generated PDF cards need a separate transparent hit area and a higher z-index delete button so card preview click and PDF deletion do not compete.
- PDF year-list parsing must reject reversed explicit ranges instead of normalizing them with `Math.min`/`Math.max`; otherwise typos such as `2024-2009` silently create the wrong book range.
- Image-only PDF post pages still need the same contextual header contract as text pages: platform, title, date, then the image area.
