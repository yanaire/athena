# Installation from source

Athena OSS Preview targets Apple Silicon Macs with macOS 13.5 or later. This is a developer source build, not an official signed or notarized installer. There is no public DMG or download for this candidate. Do not disable Gatekeeper or remove quarantine to claim installation acceptance.

Install the tools listed in [development](development.md), then from an authorized clean checkout run:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run analysis:prepare
npm run desktop:build
```

The local build produces `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Athena.app`. The ad-hoc seal used for local development is not Developer ID signing or Apple notarization. See [model providers](model-providers.md) to connect a supported model. The app contains no model weights or credentials.

For browser development with a compatible local model server:

```sh
ATHENA_ENDPOINT=http://127.0.0.1:8080/v1 ATHENA_MODEL=athena-local npm start
```

Use your model's actual slug, then open `http://127.0.0.1:4317` locally. Prepare the analysis runtime first if needed. Docker-free analysis is disabled by default for each project.

Use an isolated `ATHENA_DATA_DIR` and synthetic credentials for testing. [Credential security](keychain-security.md) covers the default local store and optional Keychain import. A clean checkout on this Mac does not establish installation or upgrade behavior on a separate Mac; that verification belongs to the desktop release.

If the previous vault cannot be imported, leave it untouched and connect the provider in Settings. Do not put passwords, tokens or private research data in test reports. See [privacy](../PRIVACY.md) and [known limitations](known-limitations.md).
