# Athena artwork

The current icons come from the original geometric owl in the repository's
`assets/icon.svg`, drawn on 2026-11-22 for this replacement. The geometry uses
circles and polygons; there are no inherited brand paths, fonts, external images,
or image-generation service outputs. The source and its exports use Apache-2.0,
as stated in the repository's `LICENSE`.

From the repository root on macOS, run:

```sh
swift assets/render-artwork.swift
```

This uses local AppKit and `iconutil` to render the 32px and 128px UI PNGs,
the 1024px desktop PNG, and a ten-frame desktop ICNS. The same command creates
the independent three-page synthetic RC sample PDF. The PDF contains new plain
text and geometric rules, references standard PDF Helvetica, and embeds no font
programs. An optional output directory lets reviewers reproduce files separately:

```sh
swift assets/render-artwork.swift /tmp/athena-artwork-review
```

`provenance.json` records exact current hashes and the superseded artwork's
immutable Git blobs. The beta repository's old provenance established origin
only: “Existing app icon reused unchanged at the request of the repository
owner.” It did not establish redistribution permission.

The old export SVGs, export QA PNGs, and hosted-evidence PNGs are excluded from
this candidate. Historical JSON reports and `BASELINE.json` describe the old
handoff, not current visual acceptance. Original bytes remain in existing
worktrees and Git history; no history was rewritten. The original UI scene
JSONs remain editable design data and contain no embedded raster brand images.

Consumers retain their existing paths: `app.html` (sidebar and response label),
`ui/settings.js` (About), `build.py` (favicon and embedded assets),
`ui/workspace-views.js` (three-page sample PDF), `src-tauri/tauri.conf.json`
(desktop PNG/ICNS), and the root README (SVG). Regenerate the standalone preview
with `build.py` after asset changes; the integration lead owns that generated file.
