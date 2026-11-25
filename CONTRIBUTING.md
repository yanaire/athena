# Contributing to Athena

The source preview is not yet approved for public distribution. Once the owner opens contribution access, use a branch and review request, follow the [development guide](docs/development.md) and [code of conduct](CODE_OF_CONDUCT.md), and update behavior and tests together. Distinguish automated fixtures from real-app, real-model, and account tests. Reproduce issues with synthetic files. Never attach credentials, vaults, private transcripts, or workspace copies.

Only contribute material you have the right to share. The owner selected [Apache-2.0](LICENSE) for Athena-owned code; third-party materials retain their own terms. Record the source, terms, and required notices for third-party code and assets. Report vulnerabilities [privately](SECURITY.md).

## Pull requests

Create a work branch and open a pull request. Target `main` for independent changes. For a stacked pull request, target its parent branch, identify the parent PR, and describe only the changes added by that layer. Preserve the stack's ancestry when merging its layers.

Before merging into `main`, update the branch to include the latest `main`, resolve review conversations, and pass the required `history-secrets`, `apple-silicon` and `browser-chat` checks. Describe the verification actually performed and any remaining limitations in the pull request. Passing CI does not establish real-model acceptance or public-release readiness.
