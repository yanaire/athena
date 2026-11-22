# Local credentials and legacy Keychain import

Athena M4.4 initializes its own credentials on startup. No Keychain access, environment variable or password is required for normal app startup, token refresh, or subsequent launch. On macOS the default store is `~/Library/Application Support/Athena/auth/credentials.v2.json`. A separate workspace selected by the host uses its own `auth/` subdirectory. Model profile metadata and conversations retain their existing workspace locations.

## Security boundary

The file is **not encrypted**. It contains API keys and OAuth tokens. Athena uses an owner-only directory (`0700`) and file (`0600`), verifies file ownership, and rejects unsafe files and symbolic links. The permissions do not protect against code running as the same OS user, an administrator, or copies made by backups. Do not share this directory or include it in diagnostic archives. FileVault can protect a locked disk; it does not protect an unlocked user session against programs running as that user.

Credential writes hold an OS-released lock across the complete read, update, and replace operation, including OAuth refresh. Athena writes a private temporary file, synchronizes it, and atomically replaces the old file. It rejects damaged data or unsafe permissions rather than silently resetting the store. Provider or registration identities are used as keys; authentication values are not placed in the workspace event log or returned in provider lists. A restored credential can still expire or be revoked by its provider.

## Import an older login

If Settings → Models offers **Approve import from Keychain**, selecting it lets the app request the existing Athena Keychain item. macOS may require your consent. Do not supply your Keychain password or a token to anyone outside the macOS approval screen. Athena never provisions or deletes a legacy item in this flow. It opens the encrypted `provider-secrets.v1` read-only; after a successful decode, it copies only entries missing from the new store and checks that they can be read back. Existing local logins take precedence. The old vault and its key are not deleted or changed.

You can skip the import and use Athena normally. If the matching key is unavailable, a provider must be reconnected through its supported sign-in method. Providers that require an API key need it entered once, directly in Athena Settings. A restored profile does not mean its provider is authenticated. Real Keychain approval is separate from automated tests, which use synthetic keys and isolated files.
