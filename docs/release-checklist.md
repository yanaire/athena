# Release checklist

## Source preview

- [ ] Fix one candidate commit and repeat the clean-clone build, tests, security review and evidence collection against that commit. A clean clone is not a clean OS installation.
- [ ] Resolve the rights of the UI handoff, artwork and inherited code; retain required third-party notices and source disclosures. See [third-party notices](../THIRD_PARTY_NOTICES.md).
- [ ] Close the [Photon exact-build and proxy notice gates](m42/notices/source-distribution.md). Keep verified provenance separate from missing notices. Coordinate dependency changes before editing either manifest or lock file.
- [ ] Include applicable source-tree notices in the source export. If distributing installed packages, WASM or apps, provide their matching notice pack and any required MPL source route; historical local review ZIPs are not a recipient delivery path.
- [ ] Create a fresh source root from the reviewed tree, with approved publishable author and committer identities. Do not include development history or the superseded source snapshot. Inspect all refs and the staged source for credentials, private data and original motion copies before pushing.
- [ ] Exercise or accurately limit the Docker-free runner; distinguish controlled provider and synthetic credential tests from real model and Keychain acceptance.
- [ ] Confirm the source build and local checks on the candidate. Record remote CI separately; local tests do not prove a remote workflow ran.
- [ ] Resolve all integration typecheck failures and retain the exact overlay or candidate identity with the [CI evidence](m42/notices/ci-readiness.md). Require native macOS arm64, macOS x64 and Windows x64 for their corresponding desktop jobs, and retain the remote run URL, checked-out commit and architecture before marking remote CI PASS.
- [ ] Enable and verify the selected GitHub private vulnerability-reporting route. If GitHub does not permit advance setup on the private repository, arrange a monitored private channel for the gap before publication; do not claim the GitHub route works until verified.
- [ ] Record the approved fallback contact in `SECURITY.md` and verify it privately if the GitHub reporting form is not operational. A generic instruction to contact a maintainer is not a configured channel.
- [ ] Keep ChatGPT sign-in disabled unless eligibility and a supported authorization path are established. Real-account acceptance is a separate follow-up.
- [ ] Obtain explicit authorization before a push, public repository transition or release publication.

## Deferred desktop release

Developer ID signing, notarization, stapling, quarantined installation and Gatekeeper acceptance, a distributable DMG, and acceptance on another physical Mac are not source-preview gates. An ad-hoc signature is not a substitute. These items must be completed before a future signed desktop distribution is claimed.
