# Cache

## Active Findings

- PDF `imageLayout` selection rules were inconsistent between per-post rendering and image-only post pages. Unified rule: `collage` mode always draws the mosaic collage regardless of image count and never draws individual images; `individual` mode always draws individual images and never a collage; `collage-individual` mode draws both only when `imagePaths.length >= 4`, otherwise individual images only. Implemented in `drawPostContentColumns` and the rewritten `drawFullPagePostImages` (now takes `imageLayout` as a parameter instead of hard-coding a `< 4` collage/individual split).
- `drawCollageImage` used PDFKit `fit` for the actual post image, which can letterbox (leave blank margin) when the image aspect ratio doesn't match the mosaic cell. Switched to `cover` so every irregular mosaic cell is filled edge-to-edge with cropped image content, matching the intended puzzle-mosaic look for both per-post collages and the page-2/last-page overview collages (both reuse `drawMosaicImageGrid` -> `drawCollageImage`).
- `drawIndividualImagesInArea` became dead code once `drawFullPagePostImages` started reusing `drawImagesInColumnThenPages` (which already paginates onto new pages instead of cramming many images into one fixed area) — removed it.
