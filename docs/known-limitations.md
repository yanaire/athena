# Known limitations

- The source candidate remains private until the UI and asset rights, third-party notices, Git history and release scope have been cleared. Selecting Apache-2.0 for Athena-owned code does not clear those materials.
- No Developer ID signed or notarized app, public DMG, or Gatekeeper installation guarantee is provided by this source preview. Those checks belong to a later desktop release.
- A clean checkout on the development Mac is not a clean operating-system installation or a separate-user acceptance test.
- ChatGPT sign-in is disabled. Controlled OAuth and provider fixtures do not establish real account access, model availability, or approval for a deployment.
- Docker-free analysis is disabled by default for each project. Wasmtime limits guest memory; a separate native watchdog samples helper memory against a 768 MiB threshold every 10 ms. This is not an allocation-time OS quota or a limit on the Node host. Crashes can leave temporary files or unpublished blobs; this is not a claim of complete operating-system isolation. See [sandbox security](sandbox-security.md).
- Conversations, uploaded research data and artifacts are stored locally and are not encrypted by the credential vault. Anyone with the same OS account can access them.
- Synthetic migration tests do not prove actual macOS authorization of the optional import. The normal launch does not request Keychain access. See [credential security](keychain-security.md).
