# Athena UI motion provenance

Reviewed 2026-11-22. Scope: the composer and controls JS/CSS, the bundled preview, and the ancestry of the local source snapshot. This is a source comparison, not a grant of redistribution rights for other UI assets.

- The creator described sending DesignBookmark's Copy for Claude/Codex prompt to OmO. The current [Motion Studies page](https://designbookmark.com/motion) uses the same prompt for both buttons: prose, links and instructions to read the linked code and rebuild for the project, not an embedded code listing. The separate Copy code control requests a code file. The exact historical prompt text was not recovered. The handoff's source comments and MOTION.md independently show that linked code and motion values were consulted.
- The files entered development in handoff commit `ffc8643`; `e3bcd87` adjusted only eight lines in the composer. The old public snapshot entered at `101da5f`. We compared it to the currently served Prompt Box, Mention Picker, Ghost Suggestion, Morph Tooltip, shared spring JS/CSS and Command Button TSX by whole-file equality, matching token runs, and inspection for renamed but structurally equivalent blocks.
- `composer.js` is mostly Athena-specific (native textarea, IME, project/attachment state, keyboard handling and lifecycle). The Prompt Box send/status render and Ghost Suggestion character construction had specific source overlap. The review tree replaces these blocks and retains the motion values, public API and layout. Mention Picker is structurally different from the upstream gallery's custom text editor and demo autoplay.
- `controls.js` integrates search and tooltips into Athena's DOM. The Command Button runtime is not the React source. Morph Tooltip had structural overlap in spring target assignment, label state, press dip and render geometry; those parts are replaced. Equation, timing, dimensions and platform DOM/CSS idioms alone were not treated as wholesale source reuse.
- The unused `motion/command-button.reference.tsx` from the handoff is an exact copy of the current upstream file (SHA-256 `f3209c8c576d0a9923e4b71d198cb2359f0b24c4e912edf2b51531ef34de8cb1`). Its header says MIT, but a complete accompanying notice was not verified; it is excluded from the review tree. Do not generalize its MIT label to the plain demos.
- `build.py` inlines the four runtime JS/CSS files; the TSX is never bundled. The regenerated HTML contains the review versions. The old five-commit `406b4d0` snapshot still contains the original implementations, compiled HTML and TSX in `101da5f`. Publishing a cleanup commit atop that root would still distribute those bytes. Use only a reviewed fresh source root; keep the old refs private.

Design credit: [DesignBookmark Motion Studies](https://designbookmark.com/motion) — Prompt Box, Mention Picker, Ghost Suggestion, Command Button and Morph Tooltip. This credit is not a third-party license grant. Artwork and other UI dependencies retain their own review status.

## Artwork replacement for the integration candidate

On 2026-11-22 the inherited beta brand PNGs, desktop PNG/ICNS, and README icon
were replaced with a newly drawn geometric owl. Its editable source is
`assets/icon.svg`. Its circles and polygon coordinates were written here without
tracing or importing the earlier artwork. Source and exports use Apache-2.0
under the root `LICENSE`. `assets/render-artwork.swift` renders every icon using
local macOS AppKit and `iconutil`; no private renderer, remote service, credentials,
or external artwork is required.

The sample PDF was independently typeset as a three-page synthetic RC fixture
with original wording and geometric rules. It preserves the viewer's page count
and the ideal 1,000-ohm / 100-nanofarad model. It embeds no system font programs:
standard PDF Helvetica is resolved by the reader.

Four historical UI SVG exports, four export QA PNGs, and seven hosted-evidence
PNGs were excluded from this candidate. These are old visual artifacts, not
evidence for the replacement. The old baseline and JSON QA reports remain
historical records; their filenames and hashes do not assert that those pictures
are still shipped. The original artwork remains recoverable from the old commit
and existing worktrees. This replacement does not authorize publication of the
old Git ancestry or clear rights in unrelated handoff code.

The asset provenance JSON records current sizes and SHA-256 values, plus the
superseded source commit, Git blob IDs, sizes and hashes for each replaced or
excluded artifact. Consumers keep the same paths, so no runtime wiring changes
are required. The integration lead regenerates `athena-preview.html` after these
inputs land and owns final bundled-artifact validation and shared notice updates.
