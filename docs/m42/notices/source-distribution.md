# Source distribution evidence

This is an evidence ledger for the private integration overlay, not a grant of redistribution rights. Inspection began at HEAD `406b4d024b0e4d11e2c4139a591acd086f1ceb75` with existing staged review changes. Those changes were retained. No final candidate commit or public source root was created by this lane.

The npm lock checked on 2026-11-22 has SHA-256 `50a6918460b3741c4e4fb55999e1c3c9743c39768969596927891c36bf75e5ae`. Byte comparisons below apply to that lock and those upstream payloads. They do not establish a clean-clone build or transfer historical app acceptance to a future commit.

| Scope | Evidence and disposition |
|---|---|
| Photon 0.3.4 root notice | **PASS** for the retained notice only. Anonymous official npm download matched the lock SHA-512; the npm and pinned upstream license matched `pi-wasm/photon-LICENSE.txt` after newline normalization. See [exact bytes and limits](pi-wasm/README.md). |
| Photon linked-code notices | **BLOCKED_EXTERNAL**. The exact npm WASM dependency graph remains unverified. Historical crate-lock, embedded-path and partial notice-ZIP reviews remain evidence with their original scope; they are not a complete npm build record. |
| proxy-agent-negotiate 1.1.0 provenance | **PASS** for SLSA and npm publish signatures, exact subject/lock/tarball agreement, trusted workflow identity and publish key validity. See [verification details](proxy-agent-negotiate.md). |
| proxy-agent-negotiate package notice | **BLOCKED_EXTERNAL**. All five npm members and the pinned upstream package tree lack an authoritative notice. Retain the MIT declaration without inventing attribution or applying a sibling license. |
| Existing QuickJS, WASI, Rust and MPL review | Retain the [Pi WASM inventory](pi-wasm/README.md), [WASI inventory](wasi/README.md), and [release audit](../release-audit.md). Historical ZIPs referenced there are local review materials, not files supplied by a clean source clone. Their contents and hashes were not reverified in this lane. |
| Artwork and inherited UI rights | Separate review lane. This ledger does not grant rights or change its results. |

Source recipients must receive the applicable notices for upstream material actually copied into the source tree, including handoff and standalone HTML outputs. Keep the notice files and their upstream attribution with any source export. Do not assume the top-level Apache-2.0 selection relicenses them.

Installed npm packages, downloaded WASM, native binaries and app bundles are additional payloads. A source export that omits them is not proof that a later packaged distribution has complete notices. Before distributing those payloads, resolve Photon and proxy notice gates, identify the actual included components, deliver the required license texts, and give recipients an available source path for any applicable MPL-covered code. A private local ZIP path is not a recipient download route.

No package manifests, lock files, upstream license texts, app payloads or assets were altered for this evidence update. Replacement of either dependency requires coordination with the integration owner and new behavior, lock and notice checks.
