# Security policy

The selected reporting route for a public Athena repository is GitHub private vulnerability reporting: on that repository, open **Security > Advisories > Report a vulnerability**. This route is not yet configured or verified for this private source candidate. Until it is available, contact a maintainer through an established private channel; do not post unpatched vulnerabilities in public issues.

Maintainers must enable and verify private vulnerability reporting and arrange a monitored private channel for any gap before publication. GitHub documents the feature for public repositories, so do not assume it can be enabled or tested on a private repository. See [GitHub's configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). No repository visibility change is authorized by this policy.

**NEEDS_USER:** no concrete monitored fallback address or channel has been selected in this source tree. The instruction to contact a maintainer is not evidence that a reporting route is operational. Before public contributions open, record the approved private contact here and verify delivery, or verify the enabled GitHub reporting form. Do not send a real vulnerability as a test.

Include the affected revision, environment, impact, and minimal steps using synthetic data. Keep credentials, vaults, and private research out of shared issue trackers. This private candidate has no published support window or bounty.

Athena is for one user on a trusted machine. The desktop host authenticates HTML, RPC, SSE, and artifact downloads over loopback. The browser development host lacks the desktop session gate. Neither host is suitable for proxying to other users. The [WASI sandbox](docs/sandbox-security.md) limits guest code; software running under your OS account can still access workspace files. See [Privacy](PRIVACY.md).
