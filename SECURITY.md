# Security policy

Report potential vulnerabilities through [GitHub private vulnerability reporting](https://github.com/yanaire/athena/security/advisories/new): open **Security > Advisories > Report a vulnerability** in `yanaire/athena`. Private vulnerability reporting is enabled for this repository. Do not post unpatched vulnerabilities in public issues.

If the reporting form is unavailable, contact a maintainer through an established private channel and wait for acknowledgement before sharing sensitive details. No separate fallback email address is published. Do not send a real vulnerability as a test. Enabling this reporting route does not change the release or contribution status described in [Contributing](CONTRIBUTING.md).

Include the affected revision, environment, impact, and minimal steps using synthetic data. Keep credentials, vaults, and private research out of shared issue trackers. Athena has no published support window or bounty.

Athena is for one user on a trusted machine. The desktop host authenticates HTML, RPC, SSE, and artifact downloads over loopback. The browser development host lacks the desktop session gate. Neither host is suitable for proxying to other users. The [WASI sandbox](docs/sandbox-security.md) limits guest code; software running under your OS account can still access workspace files. See [Privacy](PRIVACY.md).
