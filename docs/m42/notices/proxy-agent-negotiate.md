# proxy-agent-negotiate 1.1.0 notice review

Status: **BLOCKED_EXTERNAL** for redistribution notice completion. The production lock and the two consuming proxy agents pin 1.1.0. The locked archive's SHA-512 was rechecked and all five members were read. None supplies copyright attribution, MIT text, or an SPDX header. The [release commit package manifest](https://github.com/TooTallNate/proxy-agents/tree/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/negotiate) declares MIT; the release tree and the subsequently inspected upstream tree at `890a2080267b35f5accfa3ee0edd165f158a3c4d` supply no license text for this package. The earlier [release audit](../release-audit.md) verifies SLSA provenance; that ties tarball to source, not notice to package.

Before including this package in a distributed payload, obtain a package-specific notice from upstream or replace the pinned dependency chain with a verified equivalent and rerun proxy and dependency checks. Do not copy a sibling package's copyright line or treat a downstream reconstruction as authoritative. The dependency and lockfile are unchanged.

## Integration verification, 2026-11-22

Anonymous downloads from the official npm registry again matched `package-lock.json`. The 1,924-byte tarball has integrity:

```text
sha512-N8IBcM3UgCVzz2L2Lqv8DVntDnnC8/hiV4nEDUPkqq72TPUgYWjQc+bdZlBPZK9LzPAvOY//gAt0S0DApoOXWQ==
```

Its five members are `package/package.json` and `package/dist/index.{js,js.map,d.ts,d.ts.map}`. Each was read; none contains `copyright`, `Permission is hereby granted`, or `SPDX-License-Identifier`. The complete GitHub release tree at `b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16` was also checked: neither the repository root nor `packages/negotiate/` has a notice file. The package manifest's MIT declaration remains a declaration, not an authoritative notice text.

Both [official npm attestations](https://registry.npmjs.org/-/npm/v1/attestations/proxy-agent-negotiate@1.1.0) were verified with npm's bundled Sigstore implementation and a fresh TUF cache:

- SLSA v1: GitHub Actions issuer `https://token.actions.githubusercontent.com`, exact certificate identity `https://github.com/TooTallNate/proxy-agents/.github/workflows/release.yml@refs/heads/main`, certificate-log and transparency-log thresholds of one. The resolved dependency identifies the release commit above.
- npm publish v0.1: the keyed signature verified using the `npm:attestations` key from TUF's `registry.npmjs.org/keys.json`; each transparency-log integration time was within that key's validity.
- Both subjects name `pkg:npm/proxy-agent-negotiate@1.1.0` and match the downloaded tarball and lock SHA-512. A different workflow was rejected with `UNTRUSTED_SIGNER_ERROR`; a changed publish subject digest was rejected with `TLOG_BODY_ERROR`.

These results verify source and publication provenance. **BLOCKED_EXTERNAL** remains unchanged because neither signature supplies the missing package-specific notice.
